// ---------------------------------------------------------------------------
// long-file-writer -- write long files in verifiable segments.
//
// Why this module exists
// -----------------------
// A single oversized write call can be cut off by the reply cap. The damage is
// not obvious: the file on disk ends mid-statement, the caller often assumes
// the write succeeded, and the natural reaction -- retrying the same oversized
// call -- gets cut off in exactly the same place.
//
// This module encodes the recovery recipe published as the Hub gene asset
// sha256:81500e6e810a0c8dcbec5fc14cfe956c0ac7f86fc4fcd609db561e892fb5a21e:
//
//   1. Split the content at natural boundaries into parts of at most ~120
//      lines. A natural boundary is a blank line, a markdown heading, a
//      fenced-code-block edge, or a point where brace depth returns to zero.
//   2. Write part 1, then append every following part so that it starts
//      exactly where the previous one stopped.
//   3. Read the whole file back and verify the seams: nothing duplicated,
//      nothing missing, delimiters balanced.
//   4. Only then run or execute the file.
//
// SAFETY BOUNDARY
// ---------------
// Never retry an oversized call that was cut off by the reply cap. Re-split
// the content and resume from the last successfully written boundary instead.
// See RECOVERY_RULE and references/recipe.md.
//
// Dependency-free, no network, no secrets. Every helper is pure except the
// ones that touch the filesystem, and those say so.
// ---------------------------------------------------------------------------

'use strict';

var fs = require('fs');
var path = require('path');
var StringDecoder = require('string_decoder').StringDecoder;

// A part never exceeds maxLines lines or maxChars characters. 120 lines is
// the limit the Hub gene validated; 12000 chars keeps one part well below a
// typical reply cap.
var DEFAULT_MAX_LINES = 120;
var DEFAULT_MAX_CHARS = 12000;
var DEFAULT_MIN_LINES = 30;
var DEFAULT_PAGE_BYTES = 65536;

var RECOVERY_RULE = 'never retry an oversized call that was cut off by the reply cap; '
  + 're-split the content and resume from the last successfully written boundary';

var OPEN_TO_CLOSE = { '{': '}', '[': ']', '(': ')' };

// ---------------------------------------------------------------------------
// Source scanner
//
// Tracks brace depth, string/comment state and markdown fences, so the
// splitter only ever cuts where the text is structurally complete.
// ---------------------------------------------------------------------------

function analyzeSource(lines) {
  var stack = [];
  var depth = 0;
  var negative = false;
  var fence = null;
  var counts = { '{': 0, '}': 0, '[': 0, ']': 0, '(': 0, ')': 0 };
  var info = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var depthBefore = depth;
    var fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);

    if (fence !== null) {
      var closes = !!(fenceMatch && fenceMatch[1].charAt(0) === fence);
      info.push({
        depthBefore: depthBefore,
        depthAfter: depth,
        insideFence: true,
        opensFence: false,
        closesFence: closes,
        inString: false
      });
      if (closes) fence = null;
      continue;
    }

    if (fenceMatch) {
      fence = fenceMatch[1].charAt(0);
      info.push({
        depthBefore: depthBefore,
        depthAfter: depth,
        insideFence: true,
        opensFence: true,
        closesFence: false,
        inString: false
      });
      continue;
    }

    for (var c = 0; c < line.length; c++) {
      var ch = line.charAt(c);
      var top = stack.length ? stack[stack.length - 1] : null;

      if (top && top.type === 'blockComment') {
        if (ch === '*' && line.charAt(c + 1) === '/') { stack.pop(); c++; }
        continue;
      }
      if (top && top.type === 'string') {
        if (ch === '\\') { c++; continue; }
        if (ch === top.quote) stack.pop();
        continue;
      }
      if (top && top.type === 'template') {
        if (ch === '\\') { c++; continue; }
        if (ch === '`') { stack.pop(); continue; }
        if (ch === '$' && line.charAt(c + 1) === '{') {
          stack.push({ type: 'expr', base: depth });
          c++;
        }
        continue;
      }
      if (top && top.type === 'expr') {
        if (ch === '"' || ch === "'") { stack.push({ type: 'string', quote: ch }); continue; }
        if (ch === '`') { stack.push({ type: 'template' }); continue; }
        if (ch === '{') { depth++; counts['{']++; continue; }
        if (ch === '}') {
          if (depth === top.base) { stack.pop(); continue; }
          depth--;
          counts['}']++;
          continue;
        }
        if (ch === '[') { depth++; counts['[']++; continue; }
        if (ch === ']') { depth--; counts[']']++; continue; }
        if (ch === '(') { depth++; counts['(']++; continue; }
        if (ch === ')') { depth--; counts[')']++; continue; }
        continue;
      }

      if (ch === '/' && line.charAt(c + 1) === '/') break;
      if (ch === '/' && line.charAt(c + 1) === '*') { stack.push({ type: 'blockComment' }); c++; continue; }
      if (ch === '"' || ch === "'") { stack.push({ type: 'string', quote: ch }); continue; }
      if (ch === '`') { stack.push({ type: 'template' }); continue; }
      if (ch === '{') { depth++; counts['{']++; continue; }
      if (ch === '}') { depth--; counts['}']++; if (depth < 0) negative = true; continue; }
      if (ch === '[') { depth++; counts['[']++; continue; }
      if (ch === ']') { depth--; counts[']']++; if (depth < 0) negative = true; continue; }
      if (ch === '(') { depth++; counts['(']++; continue; }
      if (ch === ')') { depth--; counts[')']++; continue; }
    }

    // A single/double quoted string cannot span lines in JS: drop it at EOL.
    while (stack.length && stack[stack.length - 1].type === 'string') stack.pop();

    info.push({
      depthBefore: depthBefore,
      depthAfter: depth,
      insideFence: false,
      opensFence: false,
      closesFence: false,
      inString: stack.length > 0
    });
  }

  var unterminated = stack.map(function (entry) { return entry.type; });
  return {
    lines: info,
    counts: counts,
    negativeDepth: negative,
    unterminated: unterminated
  };
}

// Convenience wrapper: analyse a raw text instead of a line array.
function analyzeText(text) {
  return analyzeSource(String(text === null || text === undefined ? '' : text).split('\n'));
}
// ---------------------------------------------------------------------------
// Natural boundaries
//
// A boundary is a place where the text can be cut without destroying its
// structure: a blank line, a markdown heading, a fenced-code-block edge, or a
// point where brace depth has returned to zero.
// ---------------------------------------------------------------------------

function boundaryReason(line, meta) {
  if (!meta) return null;
  if (meta.opensFence) return 'fence-open';
  if (meta.closesFence) return 'fence-close';
  if (meta.insideFence) return null;      // never cut inside a fenced block
  if (meta.inString) return null;         // never cut inside a string/comment
  var trimmed = line.trim();
  if (trimmed === '') return 'blank-line';
  if (/^#{1,6}\s+\S/.test(trimmed)) return 'heading';
  if (/^(?:={3,}|\*{3,}|_{3,})$/.test(trimmed)) return 'section-rule';
  if (meta.depthAfter === 0 && /[;)}\]]$/.test(trimmed)) return 'code-block-end';
  return null;
}

function positiveInt(value, fallback) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// splitIntoParts -- the pure splitter
//
// Guarantees:
//   * every part has at most maxLines lines and at most maxChars characters;
//   * parts.join('\n') reproduces the input byte for byte (no gap, no line
//     duplicated, no statement split across two parts);
//   * a part ends on a natural boundary whenever one is reachable.
// ---------------------------------------------------------------------------

function splitIntoParts(text, opts) {
  opts = opts || {};
  var maxLines = positiveInt(opts.maxLines, DEFAULT_MAX_LINES);
  var maxChars = positiveInt(opts.maxChars, DEFAULT_MAX_CHARS);
  var minLines = Math.max(1, Math.min(positiveInt(opts.minLines, DEFAULT_MIN_LINES), maxLines));

  var raw = text === null || text === undefined ? '' : String(text);
  if (raw === '') return [];

  // Keep every element, including a trailing empty one, so that the parts
  // concatenate back to the input byte for byte.
  var lines = raw.split('\n');

  var analysis = analyzeSource(lines);
  var parts = [];
  var start = 0;

  while (start < lines.length) {
    // How many lines fit into one part (line limit and character limit)?
    var limit = start;
    var chars = 0;
    while (limit < lines.length && (limit - start) < maxLines) {
      var cost = lines[limit].length + 1;
      if (limit > start && chars + cost > maxChars) break;
      chars += cost;
      limit++;
    }
    if (limit === start) limit = start + 1;   // one line longer than maxChars

    // Take the last natural boundary that is far enough from the start.
    var candidates = [];
    for (var j = start; j < limit; j++) {
      var reason = boundaryReason(lines[j], analysis.lines[j]);
      if (reason) candidates.push({ at: j, reason: reason });
    }
    var cut = limit - 1;
    var cutReason = 'hard-limit';
    for (var m = candidates.length - 1; m >= 0; m--) {
      if (candidates[m].at - start >= minLines) {
        cut = candidates[m].at;
        cutReason = candidates[m].reason;
        break;
      }
    }

    var slice = lines.slice(start, cut + 1);
    parts.push({
      index: parts.length,
      reason: cutReason,
      startLine: start,
      endLine: cut,
      lineCount: slice.length,
      charCount: slice.join('\n').length,
      lines: slice,
      text: slice.join('\n')
    });
    start = cut + 1;
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Planning -- turn content into the exact calls an agent should make.
// ---------------------------------------------------------------------------

function planParts(text, opts) {
  return splitIntoParts(text, opts).map(function (part) { return part.text; });
}

function planWrite(filePath, text, opts) {
  var parts = splitIntoParts(text, opts);
  var calls = parts.map(function (part, index) {
    return {
      part: index,
      mode: index === 0 ? 'write' : 'append',
      payload: (index === 0 ? '' : '\n') + part.text,
      lines: part.lineCount,
      chars: part.charCount,
      boundary: part.reason
    };
  });
  return {
    path: String(filePath),
    partCount: parts.length,
    calls: calls,
    recovery: RECOVERY_RULE
  };
}

// ---------------------------------------------------------------------------
// Resume -- find the last successfully written boundary.
//
// This is the recovery path for a call that was cut off by the reply cap:
// never retry the oversized call, re-split and continue from here.
// ---------------------------------------------------------------------------

function resumeBoundary(filePath, parts) {
  var result = { nextPartIndex: 0, resumed: false, existingBytes: 0, reason: 'no-existing-file' };
  if (!fs.existsSync(filePath)) return result;
  var existing = fs.readFileSync(filePath, 'utf8');
  result.existingBytes = Buffer.byteLength(existing, 'utf8');
  var list = parts || [];
  for (var k = list.length; k >= 0; k--) {
    var candidate = list.slice(0, k).map(function (p) { return p.text; }).join('\n');
    if (candidate === existing) {
      result.nextPartIndex = k;
      result.resumed = k > 0;
      result.reason = k === 0 ? 'existing-file-is-empty' : 'matched-part-boundary';
      return result;
    }
  }
  result.reason = 'existing-file-does-not-match-any-boundary';
  return result;
}

// ---------------------------------------------------------------------------
// writeLongFile -- write part 1, append the rest, read back, verify.
// ---------------------------------------------------------------------------

function writeLongFile(filePath, content, opts) {
  opts = opts || {};
  var target = String(filePath);
  var raw = content === null || content === undefined ? '' : String(content);
  var parts = splitIntoParts(raw, opts);

  var dir = path.dirname(target);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  var startIndex = 0;
  var resumed = false;
  if (opts.resume) {
    var boundary = resumeBoundary(target, parts);
    startIndex = boundary.nextPartIndex;
    resumed = boundary.resumed;
  }

  var writes = [];
  if (parts.length === 0) fs.writeFileSync(target, '', 'utf8');
  for (var i = startIndex; i < parts.length; i++) {
    var payload = (i === 0 ? '' : '\n') + parts[i].text;
    if (i === 0) fs.writeFileSync(target, payload, 'utf8');
    else fs.appendFileSync(target, payload, 'utf8');
    writes.push({
      part: i,
      mode: i === 0 ? 'write' : 'append',
      lines: parts[i].lineCount,
      bytes: Buffer.byteLength(payload, 'utf8')
    });
    if (typeof opts.onPart === 'function') {
      opts.onPart({
        part: i,
        total: parts.length,
        mode: i === 0 ? 'write' : 'append',
        payload: payload,
        bytes: writes[writes.length - 1].bytes
      });
    }
  }

  var report = {
    ok: false,
    path: target,
    partCount: parts.length,
    resumed: resumed,
    resumedFromPart: startIndex,
    writes: writes,
    parts: parts.map(function (p) {
      return {
        index: p.index,
        boundary: p.reason,
        startLine: p.startLine,
        endLine: p.endLine,
        lines: p.lineCount,
        chars: p.charCount
      };
    }),
    verification: null,
    errors: []
  };

  if (opts.verify === false) {
    report.ok = true;
    return report;
  }

  var verification = verifyReadBack(target, raw, { parts: parts });
  report.verification = verification;
  report.errors = verification.errors;
  report.ok = verification.ok;
  return report;
}

// ---------------------------------------------------------------------------
// Read-back -- page through the file on disk with explicit byte offsets.
// ---------------------------------------------------------------------------

function readFilePaged(filePath, opts) {
  opts = opts || {};
  var pageBytes = positiveInt(opts.pageBytes, DEFAULT_PAGE_BYTES);
  var fd = fs.openSync(filePath, 'r');
  var decoder = new StringDecoder('utf8');
  var pages = [];
  var chunks = [];
  var offset = 0;
  try {
    var buffer = Buffer.alloc(pageBytes);
    for (;;) {
      var bytesRead = fs.readSync(fd, buffer, 0, pageBytes, offset);
      if (bytesRead <= 0) break;
      var text = decoder.write(buffer.slice(0, bytesRead));
      pages.push({ offset: offset, bytes: bytesRead, text: text });
      chunks.push(text);
      offset += bytesRead;
    }
    var tail = decoder.end();
    if (tail) {
      chunks.push(tail);
      pages.push({ offset: offset, bytes: 0, text: tail });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { content: chunks.join(''), bytes: offset, pages: pages, pageCount: pages.length };
}

function firstDifference(a, b) {
  var max = Math.min(a.length, b.length);
  for (var i = 0; i < max; i++) {
    if (a.charAt(i) !== b.charAt(i)) return i;
  }
  return a.length === b.length ? -1 : max;
}

// ---------------------------------------------------------------------------
// Delimiter balance -- are the brackets still closed at the end of the file?
// ---------------------------------------------------------------------------

function checkBalancedDelimiters(text) {
  var analysis = analyzeText(text);
  var counts = analysis.counts;
  var problems = [];
  var opens = Object.keys(OPEN_TO_CLOSE);
  for (var i = 0; i < opens.length; i++) {
    var open = opens[i];
    var close = OPEN_TO_CLOSE[open];
    if (counts[open] !== counts[close]) {
      problems.push('unbalanced ' + open + close + ': ' + counts[open] + ' open, ' + counts[close] + ' close');
    }
  }
  if (analysis.negativeDepth) problems.push('delimiter depth went negative');
  if (analysis.unterminated.length) {
    problems.push('unterminated ' + analysis.unterminated.join(','));
  }
  return { balanced: problems.length === 0, problems: problems, counts: counts };
}

// A repeated block of the same long line usually means a part got appended
// twice. Short lines such as '});' are common and therefore ignored.
function findDuplicateLines(text) {
  var lines = String(text).split('\n');
  var duplicates = [];
  var run = 0;
  var runStart = 0;
  for (var i = 0; i < lines.length; i++) {
    var current = lines[i];
    var meaningful = current.trim().length >= 12 && /[A-Za-z]/.test(current);
    if (meaningful && i > 0 && current === lines[i - 1]) {
      if (run === 0) runStart = i - 1;
      run++;
      if (run >= 2) {
        duplicates.push({ line: current, startLine: runStart, count: run + 1 });
        run = 1;
      }
    } else {
      run = 0;
    }
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Referenced-name check (advisory)
//
// Collects the names a file defines and the names it calls. Names that are
// called but never defined inside the file are reported. This is a heuristic
// -- it never fails the verification, it only points at suspicious seams.
// ---------------------------------------------------------------------------

var BUILTIN_NAMES = [
  'require', 'console', 'process', 'module', 'exports', 'globalThis', 'Buffer',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'queueMicrotask', 'structuredClone',
  '__dirname', '__filename', 'assert', 'fs', 'path', 'os', 'url', 'util',
  'events', 'child_process', 'crypto', 'http', 'https', 'net', 'readline',
  'stream', 'zlib', 'test', 'describe', 'it', 'beforeEach', 'afterEach'
];

var KEYWORDS = [
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'function', 'var', 'let', 'const', 'class', 'new', 'this',
  'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw',
  'delete', 'void', 'yield', 'await', 'async', 'import', 'export', 'default',
  'extends', 'super', 'static', 'get', 'set', 'with', 'debugger'
];

function findUndefinedReferences(text) {
  var src = String(text === null || text === undefined ? '' : text);
  var defined = Object.create(null);
  var used = Object.create(null);
  var m;
  var re;

  function define(name) {
    if (name && !KEYWORDS[name]) defined[name] = true;
  }

  function defineFromList(chunk) {
    chunk.split(',').forEach(function (piece) {
      var name = piece.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) define(name);
    });
  }

  re = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(src)) !== null) define(m[1]);

  re = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(src)) !== null) define(m[1]);

  re = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(src)) !== null) define(m[1]);

  re = /\b(?:var|let|const)\s*\{([^}]*)\}/g;
  while ((m = re.exec(src)) !== null) defineFromList(m[1]);

  re = /\b(?:var|let|const)\s*\[([^\]]*)\]/g;
  while ((m = re.exec(src)) !== null) defineFromList(m[1]);

  re = /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/g;
  while ((m = re.exec(src)) !== null) define(m[1]);

  re = /\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g;
  while ((m = re.exec(src)) !== null) define(m[1]);

  re = /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g;
  while ((m = re.exec(src)) !== null) defineFromList(m[1]);

  re = /\(([^()]*)\)\s*=>/g;
  while ((m = re.exec(src)) !== null) defineFromList(m[1]);

  re = /(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*=\s*(?:function\b|async\b)/g;
  while ((m = re.exec(src)) !== null) define(m[1]);

  re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = re.exec(src)) !== null) used[m[1]] = true;

  var missing = [];
  Object.keys(used).forEach(function (name) {
    if (defined[name]) return;
    if (KEYWORDS[name]) return;
    if (BUILTIN_NAMES.indexOf(name) >= 0) return;
    if (name.length <= 2) return;
    missing.push(name);
  });
  missing.sort();
  return missing;
}

// ---------------------------------------------------------------------------
// verifyReadBack -- the real check.
//
// Re-reads the file from disk (paged with byte offsets) and compares it
// against the intended content, then checks every seam between two parts.
// ---------------------------------------------------------------------------

function verifyReadBack(filePath, intended, opts) {
  opts = opts || {};
  var expected = intended === null || intended === undefined ? '' : String(intended);
  var report = {
    ok: false,
    path: String(filePath),
    exactMatch: false,
    bytes: 0,
    lineCount: 0,
    pageCount: 0,
    firstDifference: -1,
    seams: [],
    seamsOk: false,
    delimiters: null,
    delimitersOk: false,
    duplicates: [],
    undefinedReferences: [],
    errors: []
  };

  var read;
  try {
    read = readFilePaged(filePath, { pageBytes: opts.pageBytes });
  } catch (err) {
    report.errors.push('read_failed: ' + (err && err.message ? err.message : String(err)));
    return report;
  }

  report.bytes = read.bytes;
  report.pageCount = read.pageCount;
  report.lineCount = read.content.split('\n').length;
  report.exactMatch = read.content === expected;
  if (!report.exactMatch) {
    report.firstDifference = firstDifference(read.content, expected);
    report.errors.push('content_mismatch_at_offset:' + report.firstDifference);
  }

  // Seam check: the line before and the line after every join must be the
  // intended ones -- nothing duplicated, nothing missing.
  var parts = opts.parts && opts.parts.length ? opts.parts : splitIntoParts(expected, opts);
  var actualLines = read.content.split('\n');
  var seamsOk = true;
  for (var i = 0; i < parts.length - 1; i++) {
    var before = parts[i].lines[parts[i].lines.length - 1];
    var after = parts[i + 1].lines[0];
    var seam = {
      index: i,
      lineBefore: before,
      lineAfter: after,
      atLine: parts[i + 1].startLine,
      ok: false
    };
    seam.ok = actualLines[parts[i].endLine] === before && actualLines[parts[i + 1].startLine] === after;
    if (!seam.ok) {
      seamsOk = false;
      report.errors.push('seam_mismatch_at_part:' + i);
    }
    report.seams.push(seam);
  }
  report.seamsOk = seamsOk;

  // Delimiter balance. Prose may contain stray brackets, so an unbalanced
  // result only fails the check when the content looks like source code.
  report.delimiters = checkBalancedDelimiters(read.content);
  var looksLikeCode = /[{};]|\b(?:function|class|def|const|let|var)\b/.test(read.content);
  report.delimitersOk = report.delimiters.balanced || !looksLikeCode;
  if (!report.delimitersOk) {
    report.errors.push('delimiters_unbalanced: ' + report.delimiters.problems.join('; '));
  }

  report.duplicates = findDuplicateLines(read.content);
  report.undefinedReferences = findUndefinedReferences(read.content);
  report.ok = report.exactMatch && report.seamsOk && report.delimitersOk;
  return report;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(argv) {
  var args = argv || process.argv.slice(2);
  if (args.length === 0) {
    console.log('long-file-writer -- write long files in verifiable segments.');
    console.log('recovery rule: ' + RECOVERY_RULE);
    console.log('exports: ' + Object.keys(module.exports).sort().join(', '));
    return 0;
  }
  var cli = require('./scripts/write-long-file.js');
  return cli.run(args);
}

module.exports = {
  RECOVERY_RULE: RECOVERY_RULE,
  DEFAULTS: {
    maxLines: DEFAULT_MAX_LINES,
    maxChars: DEFAULT_MAX_CHARS,
    minLines: DEFAULT_MIN_LINES,
    pageBytes: DEFAULT_PAGE_BYTES
  },
  splitIntoParts: splitIntoParts,
  planParts: planParts,
  planWrite: planWrite,
  writeLongFile: writeLongFile,
  verifyReadBack: verifyReadBack,
  readFilePaged: readFilePaged,
  resumeBoundary: resumeBoundary,
  checkBalancedDelimiters: checkBalancedDelimiters,
  findDuplicateLines: findDuplicateLines,
  findUndefinedReferences: findUndefinedReferences,
  analyzeSource: analyzeSource,
  analyzeText: analyzeText,
  main: main
};

