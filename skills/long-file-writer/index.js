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
  opts = opts || {};
  if (opts.transport === 'exec') {
    var plan = planExecAppend(filePath, text, opts);
    return {
      path: plan.path,
      partCount: plan.segmentCount,
      transport: 'exec',
      calls: plan.segments.map(function (seg) {
        return {
          part: seg.index,
          mode: seg.mode,
          tool: seg.tool,
          encoding: seg.encoding,
          payload: seg.payload,
          lines: seg.lines,
          chars: seg.chars,
          boundary: seg.mode === 'write' ? 'exec-write' : 'exec-append'
        };
      }),
      payloads: plan.payloads,
      segments: plan.segments,
      recovery: RECOVERY_RULE
    };
  }
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
  var writeTarget = target;
  var atomic = opts.atomic === true;
  if (atomic && opts.verify === false) {
    throw new Error('atomic mode requires verification');
  }
  var raw = content === null || content === undefined ? '' : String(content);
  var parts = splitIntoParts(raw, opts);

  var dir = path.dirname(target);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (atomic) writeTarget = target + '.segmented-' + process.pid + '-' + Date.now() + '.tmp';

  var startIndex = 0;
  var resumed = false;
  if (opts.resume) {
    if (atomic) throw new Error('atomic and resume modes cannot be combined');
    var boundary = resumeBoundary(target, parts);
    startIndex = boundary.nextPartIndex;
    resumed = boundary.resumed;
  }

  var writes = [];
  try {
    if (parts.length === 0) fs.writeFileSync(writeTarget, '', 'utf8');
    for (var i = startIndex; i < parts.length; i++) {
      var payload = (i === 0 ? '' : '\n') + parts[i].text;
      if (i === 0) fs.writeFileSync(writeTarget, payload, 'utf8');
      else fs.appendFileSync(writeTarget, payload, 'utf8');
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
  } catch (err) {
    if (atomic && fs.existsSync(writeTarget)) fs.unlinkSync(writeTarget);
    throw err;
  }

  var report = {
    ok: false,
    path: target,
    execPlan: opts.transport === 'exec' ? planExecAppend(target, raw, opts) : null,
    atomic: atomic,
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

  var verification = verifyReadBack(writeTarget, raw, { parts: parts });
  report.verification = verification;
  report.errors = verification.errors;
  report.ok = verification.ok;
  if (atomic) {
    if (report.ok) fs.renameSync(writeTarget, target);
    else if (fs.existsSync(writeTarget)) fs.unlinkSync(writeTarget);
  }
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
// Code-mode exec safety
//
// In OpenClaw code mode a payload is embedded in a JavaScript cell. Two
// failure modes bite there:
//
//   (a) an unescaped backtick or dollar-brace pair inside a template
//       literal ends the literal early -> SyntaxError ... Unexpected token,
//       and the WHOLE cell never runs: nothing partial happens and there
//       is nothing to resume;
//   (b) a payload larger than the reply cap is truncated mid-statement.
//
// escapeTemplateLiteral() fixes (a) for text that has to live inside a
// template literal. planExecAppend() fixes both: the payload travels as
// base64 through a python one-liner, so no byte of it can be
// reinterpreted by the JavaScript parser, the shell or the template
// literal. scanTemplateLiterals() is the guard that catches the problem
// before the cell is sent.
//
// The backtick and the dollar sign are spelled out as escapes so that this
// file itself holds no character that would break a template literal when
// this file is pasted into one.
// ---------------------------------------------------------------------------

var TICK = '\x60';
var DOLLAR = '\x24';
var DOLLAR_BRACE = '\x24{';

// The python one-liner that appends one base64 chunk. The shell quotes are
// single and the python string quotes are double, so the finished command
// holds no backtick, no dollar sign and no backslash: it can be dropped
// into a JavaScript template literal unchanged.
var PY_APPEND_SNIPPET = 'import base64,sys;open(sys.argv[1],"ab").write(base64.b64decode(sys.argv[2]))';

// escapeTemplateLiteral -- make arbitrary text safe inside a JS template
// literal. Round-trip safe: evaluating the escaped text as a template
// literal yields the original string byte for byte.
function escapeTemplateLiteral(text) {
  var src = text === null || text === undefined ? '' : String(text);
  var out = '';
  for (var i = 0; i < src.length; i++) {
    var ch = src.charAt(i);
    var code = src.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === TICK) out += '\\' + TICK;
    else if (ch === '\r') out += '\\r';
    else if (code === 0x2028) out += '\\u2028';
    else if (code === 0x2029) out += '\\u2029';
    else if (ch === DOLLAR && src.charAt(i + 1) === '{') { out += '\\' + DOLLAR_BRACE; i++; }
    else out += ch;
  }
  return out;
}

// unescapeTemplateLiteral -- the inverse of escapeTemplateLiteral.
function unescapeTemplateLiteral(text) {
  var src = text === null || text === undefined ? '' : String(text);
  var out = '';
  for (var i = 0; i < src.length; i++) {
    var ch = src.charAt(i);
    if (ch !== '\\') { out += ch; continue; }
    var next = src.charAt(i + 1);
    if (next === '\\') { out += '\\'; i++; }
    else if (next === TICK) { out += TICK; i++; }
    else if (next === DOLLAR) { out += DOLLAR; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 'u') {
      var hex = src.substr(i + 2, 4);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; }
      else out += ch;
    }
    else out += ch;
  }
  return out;
}

// isTemplateSafe -- can this text be dropped into a template literal
// unchanged? No backtick, no backslash, no dollar-brace pair.
function isTemplateSafe(text) {
  var src = text === null || text === undefined ? '' : String(text);
  for (var i = 0; i < src.length; i++) {
    var ch = src.charAt(i);
    if (ch === '\\' || ch === TICK) return false;
    if (ch === DOLLAR && src.charAt(i + 1) === '{') return false;
  }
  return true;
}

// shellQuotePath -- quote a path for the shell when it is not already safe.
function shellQuotePath(value) {
  var p = String(value);
  if (/^[A-Za-z0-9._\-\/]+$/.test(p)) return p;
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

// splitForExec -- cut text into chunks that fit the byte and the line
// budget. The chunks concatenate back to the input byte for byte: no
// separator is inserted, so the append path cannot corrupt the file.
function splitForExec(text, maxLines, maxBytes) {
  var src = text === null || text === undefined ? '' : String(text);
  var n = src.length;
  var chunks = [];
  var start = 0;
  var pos = 0;
  var lines = 0;
  var bytes = 0;
  var lastBreak = -1;

  while (pos < n) {
    var cp = src.codePointAt(pos);
    var unit = cp > 0xFFFF ? 2 : 1;
    var cpBytes = cp <= 0x7F ? 1 : (cp <= 0x7FF ? 2 : (cp <= 0xFFFF ? 3 : 4));
    var overBytes = bytes + cpBytes > maxBytes;
    var overLines = lines >= maxLines;
    if ((overBytes || overLines) && pos > start) {
      var cut = (lastBreak > start) ? lastBreak : pos;
      chunks.push(src.slice(start, cut));
      start = cut;
      bytes = 0;
      lines = 0;
      lastBreak = -1;
      pos = cut;
      continue;
    }
    bytes += cpBytes;
    if (cp === 10) { lines++; lastBreak = pos + unit; }
    pos += unit;
  }
  if (start < n) chunks.push(src.slice(start));
  return chunks;
}

// planExecAppend -- the exec-safe write path.
//
// Segment 1 is the content for the write tool. Every later segment is a
// complete shell command that appends one base64 chunk to the file. The
// base64 payload travels through the shell unchanged, so no escaping
// decision is left to the caller and the command can be embedded in a
// JavaScript template literal as it is.
function planExecAppend(filePath, text, opts) {
  opts = opts || {};
  var target = String(filePath);
  var maxLines = positiveInt(opts.maxLines, DEFAULT_MAX_LINES);
  var maxChars = positiveInt(opts.maxChars, DEFAULT_MAX_CHARS);
  var python = (typeof opts.python === 'string' && opts.python.trim()) ? opts.python.trim() : PY_APPEND_SNIPPET;
  var pythonArg = "'" + python.replace(/'/g, "'\\''") + "'";
  var pathArg = shellQuotePath(target);
  var prefix = 'python3 -c ' + pythonArg + ' ' + pathArg + ' ';
  // base64 costs 4 characters per 3 source bytes.
  var budget = Math.max(1, Math.floor((maxChars - prefix.length) / 4) * 3);
  var raw = text === null || text === undefined ? '' : String(text);
  var chunks = splitForExec(raw, maxLines, budget);

  // The first segment is the content for the write tool. A resume plan
  // needs every segment to be an append instead, because the file already
  // holds the earlier parts; firstMode:'append' selects that.
  var firstMode = opts.firstMode === 'append' ? 'append' : 'write';
  var segments = [];
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    if (i === 0 && firstMode === 'write') {
      segments.push({
        index: 0,
        mode: 'write',
        tool: 'write',
        encoding: 'raw',
        payload: chunk,
        text: chunk,
        escaped: escapeTemplateLiteral(chunk),
        json: JSON.stringify(chunk),
        lines: chunk.split('\n').length,
        chars: chunk.length,
        bytes: Buffer.byteLength(chunk, 'utf8'),
        templateSafe: isTemplateSafe(escapeTemplateLiteral(chunk))
      });
      continue;
    }
    var encoded = Buffer.from(chunk, 'utf8').toString('base64');
    var command = prefix + encoded;
    segments.push({
      index: i,
      mode: 'append',
      tool: 'exec',
      encoding: 'base64',
      payload: command,
      command: command,
      text: chunk,
      encoded: encoded,
      lines: chunk.split('\n').length,
      chars: chunk.length,
      bytes: Buffer.byteLength(chunk, 'utf8'),
      templateSafe: isTemplateSafe(command)
    });
  }

  return {
    path: target,
    strategy: 'write-then-base64-append',
    segmentCount: segments.length,
    payloads: segments.map(function (s) { return s.payload; }),
    segments: segments,
    python: python,
    maxChars: maxChars,
    maxLines: maxLines,
    recovery: RECOVERY_RULE
  };
}

// ---------------------------------------------------------------------------
// Reply-cap cutoff detection and the two repairs the Hub gene asks for
//
// The Hub gene asset
// sha256:81500e6e810a0c8dcbec5fc14cfe956c0ac7f86fc4fcd609db561e892fb5a21e
// lists two anti-patterns, each with a repair step:
//
//   1. tool_result_says_the_call_was_cut_off_by_the_reply_cap
//      Repair: Do not retry the same oversized call; re-split into smaller
//              ~120-line parts and resume from the last successfully written
//              boundary.
//
//   2. read_back_shows_duplicated_lines_missing_text_unbalanced_brackets_tags_or_names_
//      Repair: Fix the offending seam by rewriting or appending only the
//              missing/corrected span so parts meet exactly.
//
// detectReplyCapCutoff does the noticing (the tool result is text, an agent
// has to recognise that it was truncated), planResumeAfterCutoff does the
// re-splitting, planSeamRepair produces the corrective payload.
// ---------------------------------------------------------------------------

// Every phrase below is one a tool actually uses when it refuses to return a
// payload in full. The list is deliberately short: a false positive would
// throw a perfectly good file into the recovery path.
var CUTOFF_SIGNALS = [
  { id: 'reply-cap', re: /\breply\s*cap\b/i, confidence: 0.95 },
  { id: 'cut-off', re: /\bcut\s*[- ]?\s*off\b/i, confidence: 0.92 },
  { id: 'truncated', re: /\btruncat(?:ed|ion|e|ing)\b/i, confidence: 0.88 },
  { id: 'output-limit', re: /\b(?:output|reply|response|payload|content)\s+(?:size\s+)?(?:limit|cap|ceiling)\b/i, confidence: 0.9 },
  { id: 'max-output', re: /\b(?:max|maximum)\s*(?:output|reply|response|token|character|byte|payload|message)\b/i, confidence: 0.82 },
  { id: 'exceeds-limit', re: /\b(?:exceeds?|exceeded|exceeding)\b[^.\n]{0,40}\b(?:limit|cap|maximum|max|quota|allowance)\b/i, confidence: 0.85 },
  { id: 'character-limit', re: /\bcharacter\s+limit\b/i, confidence: 0.85 },
  { id: 'maximum-length', re: /\bmaximum\s+length\b/i, confidence: 0.78 },
  { id: 'too-long', re: /\btoo\s+long\b/i, confidence: 0.7 }
];

// A negation means the opposite of a cutoff and must not trigger the
// recovery path: 'no cutoff', 'not truncated', '{"cutoff": false}'.
function negatedAround(src, index, length) {
  var before = src.slice(Math.max(0, index - 24), index);
  var after = src.slice(index + length, index + length + 24);
  if (/\b(?:no|not|never|without|zero|false)\s*(?:\w+\s*){0,2}$/.test(before)) return true;
  if (/^["']?\s*[:=]\s*["']?false/.test(after)) return true;
  return false;
}

// detectReplyCapCutoff -- does this tool result report a truncated call?
//
// Returns { cutoff, reason, confidence }. confidence is the strength of the
// cutoff signal: 0 when nothing matched. A normal successful result always
// returns cutoff:false.
function detectReplyCapCutoff(text) {
  var raw = text;

  if (raw && typeof raw === 'object') {
    var explicit = null;
    if (typeof raw.cutoff === 'boolean') explicit = raw.cutoff;
    else if (typeof raw.truncated === 'boolean') explicit = raw.truncated;
    else if (typeof raw.isTruncated === 'boolean') explicit = raw.isTruncated;
    if (explicit !== null) {
      return {
        cutoff: explicit,
        reason: explicit ? 'explicit-flag' : 'explicit-flag-false',
        confidence: explicit ? 1 : 0,
        matched: 'explicit-flag',
        evidence: null
      };
    }
    raw = raw.message || raw.error || raw.text || raw.output || raw.content || raw.result;
    if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
  }

  var src = raw === null || raw === undefined ? '' : String(raw);
  if (src.trim() === '') {
    return { cutoff: false, reason: 'empty-result', confidence: 0, matched: null, evidence: null };
  }

  var best = null;
  for (var i = 0; i < CUTOFF_SIGNALS.length; i++) {
    var signal = CUTOFF_SIGNALS[i];
    var m = signal.re.exec(src);
    if (!m) continue;
    if (negatedAround(src, m.index, m[0].length)) continue;
    if (!best || signal.confidence > best.confidence) {
      best = { id: signal.id, confidence: signal.confidence, evidence: m[0] };
    }
  }

  if (!best) {
    return { cutoff: false, reason: 'no-cutoff-phrase', confidence: 0, matched: null, evidence: null };
  }
  return {
    cutoff: true,
    reason: 'cutoff-phrase:' + best.id,
    confidence: best.confidence,
    matched: best.id,
    evidence: best.evidence
  };
}

// commonPrefixLength -- how many characters the two texts share.
function commonPrefixLength(a, b) {
  var n = Math.min(a.length, b.length);
  for (var i = 0; i < n; i++) {
    if (a.charAt(i) !== b.charAt(i)) return i;
  }
  return n;
}

// offsetOfLine -- the character offset where a line starts.
function offsetOfLine(text, lineIndex) {
  var lines = String(text).split('\n');
  var offset = 0;
  for (var i = 0; i < lineIndex && i < lines.length; i++) offset += lines[i].length + 1;
  return offset;
}

// withFirstMode -- copy the options and force the first segment mode.
function withFirstMode(opts, mode) {
  var out = {};
  if (opts) {
    for (var key in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, key)) out[key] = opts[key];
    }
  }
  out.firstMode = mode;
  return out;
}

// segmentsToCalls -- the exec segments as ordered tool calls.
function segmentsToCalls(segments) {
  return segments.map(function (seg) {
    return {
      step: seg.index,
      part: seg.index,
      mode: seg.mode,
      tool: seg.tool,
      encoding: seg.encoding,
      payload: seg.payload,
      lines: seg.lines,
      chars: seg.chars,
      bytes: seg.bytes,
      templateSafe: seg.templateSafe,
      boundary: seg.mode === 'write' ? 'exec-write' : 'exec-append'
    };
  });
}

// planPlainContinuation -- the same continuation for a transport that takes
// the raw text (the newline in front of every part is what makes the parts
// join exactly).
function planPlainContinuation(parts, startIndex) {
  var calls = [];
  for (var i = startIndex; i < parts.length; i++) {
    calls.push({
      step: calls.length,
      part: i,
      mode: i === 0 ? 'write' : 'append',
      tool: 'write-or-append',
      encoding: 'raw',
      payload: (i === 0 && startIndex === 0 ? '' : '\n') + parts[i].text,
      lines: parts[i].lineCount,
      chars: parts[i].charCount,
      boundary: parts[i].reason
    });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// planResumeAfterCutoff -- the ordered continuation after a cutoff.
//
// Anti-pattern 1 of the Hub gene: the tool result says the call was cut off
// by the reply cap. The repair is NOT to retry the same oversized call but to
// re-split into parts of at most ~120 lines and resume from the last
// successfully written boundary.
//
// The splitter (splitIntoParts), the boundary finder (resumeBoundary) and the
// exec payload builder (planExecAppend) are reused, not reimplemented.
// ---------------------------------------------------------------------------

function planResumeAfterCutoff(filePath, content, toolResultText, opts) {
  opts = opts || {};
  var target = String(filePath);
  var raw = content === null || content === undefined ? '' : String(content);
  var detection = detectReplyCapCutoff(toolResultText);

  var plan = {
    path: target,
    cutoff: detection.cutoff,
    reason: detection.reason,
    confidence: detection.confidence,
    detection: detection,
    strategy: 'none',
    resumedFromPart: 0,
    totalParts: 0,
    existingBytes: 0,
    boundaryReason: 'not-checked',
    problem: null,
    repair: null,
    segments: [],
    calls: [],
    payloads: [],
    recovery: RECOVERY_RULE,
    next: ''
  };

  if (!detection.cutoff) {
    plan.next = 'no cutoff reported: the tool result does not describe a truncated call, '
      + 'do not re-split and do not retry the same call';
    return plan;
  }

  var parts = splitIntoParts(raw, opts);
  plan.totalParts = parts.length;

  var exists = fs.existsSync(target);
  var boundary = exists
    ? resumeBoundary(target, parts)
    : { nextPartIndex: 0, resumed: false, existingBytes: 0, reason: 'no-existing-file' };
  plan.existingBytes = boundary.existingBytes;
  plan.boundaryReason = boundary.reason;

  // 1. nothing landed on disk: write the whole file again, in small parts.
  if (!exists) {
    var full = planExecAppend(target, raw, opts);
    plan.strategy = 'write-from-start';
    plan.resumedFromPart = 0;
    plan.segments = full.segments;
    plan.calls = segmentsToCalls(full.segments);
    plan.payloads = full.payloads;
    plan.next = 'apply the calls in order: the write segment first, the appends after';
    return plan;
  }

  // 2. the file ends exactly on a part boundary: append the rest.
  if (boundary.resumed) {
    plan.strategy = 'resume-at-part-boundary';
    plan.resumedFromPart = boundary.nextPartIndex;
    if (opts.transport === 'plain') {
      var plainCalls = planPlainContinuation(parts, boundary.nextPartIndex);
      plan.calls = plainCalls;
      plan.payloads = plainCalls.map(function (c) { return c.payload; });
    } else {
      // The newline in front of the first continued part is what makes the
      // parts meet exactly: the file ends with the last written part.
      var remaining = (boundary.nextPartIndex > 0 ? '\n' : '')
        + parts.slice(boundary.nextPartIndex).map(function (p) { return p.text; }).join('\n');
      var tail = planExecAppend(target, remaining, withFirstMode(opts, 'append'));
      plan.segments = tail.segments;
      plan.calls = segmentsToCalls(tail.segments);
      plan.payloads = tail.payloads;
    }
    plan.next = 'apply the calls in order, then verify with verifyReadBack';
    return plan;
  }

  // 3. the file was cut in the middle of a part: rewrite the good prefix and
  //    append the corrected remainder.
  var repair = planSeamRepair(target, raw, opts);
  plan.strategy = 'rewrite-prefix-and-append';
  plan.problem = repair.problem;
  plan.repair = repair.repair;
  plan.segments = repair.segments;
  plan.calls = repair.calls;
  plan.payloads = repair.payloads;
  plan.next = repair.next;
  return plan;
}

// ---------------------------------------------------------------------------
// locateFirstProblem -- where the file on disk first goes wrong.
//
// Kinds: duplicate-lines, missing-span, extra-content, unbalanced-delimiters
// and the generic content-mismatch.
// ---------------------------------------------------------------------------

function locateFirstProblem(actual, expected, opts) {
  var actualLines = actual.split('\n');
  var expectedLines = expected.split('\n');
  var max = Math.min(actualLines.length, expectedLines.length);
  var lineDiff = 0;
  while (lineDiff < max && actualLines[lineDiff] === expectedLines[lineDiff]) lineDiff++;

  var offset = firstDifference(actual, expected);
  if (offset < 0) offset = 0;

  var problem = {
    kind: 'content-mismatch',
    atOffset: offset,
    atLine: lineDiff,
    seamIndex: null,
    detail: 'the file diverges from the intended content at line ' + lineDiff,
    duplicates: findDuplicateLines(actual),
    delimiters: null
  };

  // Which seam does the divergence belong to?
  var parts = splitIntoParts(expected, opts);
  var seamIndex = null;
  for (var i = 0; i < parts.length - 1; i++) {
    if (parts[i + 1].startLine <= lineDiff) seamIndex = i;
    else break;
  }
  problem.seamIndex = seamIndex === null ? 0 : seamIndex;

  // The line at the divergence occurs more than once in the file: the append
  // ran twice, or it started with a line the file already had.
  var dupAt = -1;
  var dupOrigin = -1;
  if (lineDiff < actualLines.length) {
    var candidate = actualLines[lineDiff];
    if (candidate.trim().length >= 4 && /[A-Za-z]/.test(candidate)) {
      for (var q = 0; q < actualLines.length; q++) {
        if (q !== lineDiff && actualLines[q] === candidate) { dupAt = lineDiff; dupOrigin = q; break; }
      }
    }
  }
  if (dupAt >= 0) {
    problem.kind = 'duplicate-lines';
    problem.atLine = dupAt;
    problem.atOffset = offsetOfLine(actual, dupAt);
    problem.duplicateOrigin = dupOrigin;
    problem.detail = 'the line is repeated at the seam (also at line ' + dupOrigin + '): "' + actualLines[dupAt] + '"';
    return problem;
  }

  // The file stops short of the intended content: a part was cut off.
  if (lineDiff === actualLines.length) {
    problem.kind = 'missing-span';
    problem.detail = 'the file ends after ' + actualLines.length + ' lines, the intended content has ' + expectedLines.length;
    return problem;
  }

  // The file carries content the intended content does not have.
  if (lineDiff === expectedLines.length) {
    problem.kind = 'extra-content';
    problem.detail = 'the file has ' + actualLines.length + ' lines, the intended content has ' + expectedLines.length;
    return problem;
  }

  var balance = checkBalancedDelimiters(actual);
  problem.delimiters = balance;
  if (!balance.balanced) {
    problem.kind = 'unbalanced-delimiters';
    problem.detail = balance.problems.join('; ');
    return problem;
  }

  return problem;
}

// ---------------------------------------------------------------------------
// planSeamRepair -- the minimal corrective payload for a broken seam.
//
// Anti-pattern 2 of the Hub gene: the read-back shows duplicated lines,
// missing text, unbalanced brackets/tags or names that are used but never
// defined. The repair is to rewrite or append only the missing/corrected
// span so the parts meet exactly.
//
// The correction is expressed as: rewrite the good prefix with the write
// tool (a write always replaces the whole file, so this is the smallest
// change that can drop the duplicated span) and append the corrected span.
// When the file on disk is a clean prefix of the intended content the repair
// is append-only and nothing is rewritten.
// ---------------------------------------------------------------------------

function planSeamRepair(filePath, content, opts) {
  opts = opts || {};
  var target = String(filePath);
  var expected = content === null || content === undefined ? '' : String(content);

  var report = {
    ok: false,
    path: target,
    problem: null,
    repair: null,
    segments: [],
    calls: [],
    payloads: [],
    verification: null,
    recovery: RECOVERY_RULE,
    next: ''
  };

  if (!fs.existsSync(target)) {
    report.problem = { kind: 'missing-file', atOffset: 0, atLine: 0, detail: 'the target file does not exist' };
    var whole = planExecAppend(target, expected, opts);
    report.repair = { kind: 'write-everything', payload: expected, span: { from: 0, to: expected.length } };
    report.segments = whole.segments;
    report.calls = segmentsToCalls(whole.segments);
    report.payloads = whole.payloads;
    report.ok = true;
    report.verification = { fn: 'verifyReadBack', path: target, args: [target, expected] };
    report.next = 'apply the calls in order, then run verifyReadBack';
    return report;
  }

  var actual;
  try {
    actual = readFilePaged(target, { pageBytes: opts.pageBytes }).content;
  } catch (err) {
    report.problem = { kind: 'read-failed', atOffset: 0, atLine: 0, detail: err && err.message ? err.message : String(err) };
    return report;
  }

  if (actual === expected) {
    report.ok = true;
    report.repair = { kind: 'none', payload: '', span: null };
    report.verification = { fn: 'verifyReadBack', path: target, args: [target, expected] };
    report.next = 'nothing to repair: the file already equals the intended content';
    return report;
  }

  report.problem = locateFirstProblem(actual, expected, opts);

  var prefixLen = commonPrefixLength(actual, expected);
  var lineStart = prefixLen > 0 ? expected.lastIndexOf('\n', prefixLen - 1) + 1 : 0;
  var actualIsPrefix = expected.indexOf(actual) === 0;
  var appendOnly = actualIsPrefix && (actual === '' || actual.charAt(actual.length - 1) === '\n');

  var prefix = appendOnly ? actual : expected.slice(0, lineStart);
  var remainder = expected.slice(appendOnly ? actual.length : lineStart);

  var calls = [];
  var step = 0;
  if (!appendOnly) {
    calls.push({
      step: step++,
      part: null,
      mode: 'rewrite',
      tool: 'write',
      encoding: 'raw',
      payload: prefix,
      lines: prefix === '' ? 0 : prefix.split('\n').length,
      chars: prefix.length,
      boundary: 'rewrite-prefix'
    });
  }

  var segments = [];
  var payloads = [];
  if (opts.transport === 'plain') {
    var rparts = splitIntoParts(remainder, opts);
    for (var i = 0; i < rparts.length; i++) {
      var pc = {
        step: step++,
        part: i,
        mode: 'append',
        tool: 'append',
        encoding: 'raw',
        payload: (i === 0 ? '' : '\n') + rparts[i].text,
        lines: rparts[i].lineCount,
        chars: rparts[i].charCount,
        boundary: rparts[i].reason
      };
      calls.push(pc);
      payloads.push(pc.payload);
    }
  } else {
    var tail = planExecAppend(target, remainder, withFirstMode(opts, 'append'));
    segments = tail.segments;
    var tCalls = segmentsToCalls(tail.segments);
    tCalls.forEach(function (c) { c.step = step++; calls.push(c); });
    payloads = tail.payloads;
  }

  report.repair = {
    kind: appendOnly ? 'append-missing-span' : 'rewrite-prefix-and-append',
    payload: remainder,
    span: { from: appendOnly ? actual.length : lineStart, to: expected.length },
    prefixBytes: prefix.length
  };
  report.segments = segments;
  report.calls = calls;
  report.payloads = payloads;
  report.verification = {
    fn: 'verifyReadBack',
    path: target,
    args: [target, expected],
    note: 'run verifyReadBack after the repair: the file must then equal the intended content byte for byte'
  };
  if (opts.sourcePath) {
    report.verification.command = 'node -e "var w=require(\'./skills/long-file-writer\');var fs=require(\'fs\');'
      + 'var r=w.verifyReadBack(process.argv[1],fs.readFileSync(process.argv[2],\'utf8\'));'
      + 'console.log(JSON.stringify(r));process.exit(r.ok?0:1)" ' + target + ' ' + opts.sourcePath;
  }
  report.ok = true;
  report.next = appendOnly
    ? 'apply the append calls in order, then run verifyReadBack'
    : 'rewrite the prefix with the write tool, apply the append calls in order, then run verifyReadBack';
  return report;
}

// scanTemplateLiterals -- the guard.
//
// Scans a code-mode payload and reports every template literal that is
// unsafe to send: too big for the reply cap, carrying an unescaped
// backtick, carrying a dollar-brace interpolation, or never closed.
function scanTemplateLiterals(code, opts) {
  opts = opts || {};
  var src = code === null || code === undefined ? '' : String(code);
  var n = src.length;
  var maxChars = positiveInt(opts.maxChars, DEFAULT_MAX_CHARS);
  var maxLines = positiveInt(opts.maxLines, DEFAULT_MAX_LINES);
  var strict = opts.strict !== false;

  var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete',
    'void', 'do', 'else', 'yield', 'await', 'throw', 'instanceof'];

  var literals = [];
  var issues = [];
  var literalSeq = 0;

  function skipLineComment(j) {
    while (j < n && src.charAt(j) !== '\n') j++;
    return j;
  }

  function skipBlockComment(j) {
    j += 2;
    while (j < n) {
      if (src.charAt(j) === '*' && src.charAt(j + 1) === '/') return j + 2;
      j++;
    }
    return n;
  }

  function skipQuoted(j, quote) {
    j++;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === quote) return j + 1;
      if (c === '\n') return j;
      j++;
    }
    return n;
  }

  function skipRegex(j) {
    j++;
    var inClass = false;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { j++; break; }
      else if (c === '\n') break;
      j++;
    }
    while (j < n && /[a-z]/.test(src.charAt(j))) j++;
    return j;
  }

  // A slash starts a regex when the previous significant token asks for
  // one; otherwise it is a division.
  function regexAllowed(j) {
    var k = j - 1;
    while (k >= 0) {
      var c = src.charAt(k);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { k--; continue; }
      if (c === ')' || c === ']') return false;
      if (/[A-Za-z0-9_$]/.test(c)) {
        var end = k + 1;
        var start = k;
        while (start >= 0 && /[A-Za-z0-9_$]/.test(src.charAt(start))) start--;
        return REGEX_KEYWORDS.indexOf(src.slice(start + 1, end)) >= 0;
      }
      return true;
    }
    return true;
  }

  function countUnescapedTicks(body) {
    var count = 0;
    var slashes = 0;
    for (var k = 0; k < body.length; k++) {
      var c = body.charAt(k);
      if (c === '\\') { slashes++; continue; }
      if (c === TICK) { if (slashes % 2 === 0) count++; slashes = 0; continue; }
      slashes = 0;
    }
    return count;
  }

  function recordLiteral(lit) {
    var uid = literalSeq++;
    var body = lit.body;
    var entry = {
      uid: uid,
      index: uid,
      start: lit.start,
      end: lit.end,
      chars: body.length,
      lines: body.split('\n').length,
      unescapedBackticks: countUnescapedTicks(body),
      interpolations: lit.interpolations,
      unterminated: lit.unterminated,
      types: []
    };
    if (opts.includeBody) entry.body = body;
    else entry.preview = body.slice(0, 120);
    literals.push(entry);

    function add(type, severity, message) {
      entry.types.push(type);
      issues.push({
        type: type,
        severity: severity,
        literal: uid,
        start: lit.start,
        end: lit.end,
        message: message
      });
    }

    if (entry.chars > maxChars) {
      add('oversize-chars', 'error', 'template literal is ' + entry.chars + ' characters, the safe limit is ' + maxChars);
    }
    if (entry.lines > maxLines) {
      add('oversize-lines', 'error', 'template literal is ' + entry.lines + ' lines, the safe limit is ' + maxLines);
    }
    if (entry.unescapedBackticks > 0) {
      add('unescaped-backtick', 'error', 'template literal carries ' + entry.unescapedBackticks + ' unescaped backtick(s)');
    }
    if (entry.interpolations > 0) {
      add('interpolation', strict ? 'error' : 'warn', 'template literal carries ' + entry.interpolations + ' interpolation(s)');
    }
    if (entry.unterminated) {
      add('unterminated', 'error', 'template literal is never closed');
    }
    return entry;
  }

  function scanTemplate(start) {
    var j = start + 1;
    var bodyStart = j;
    var interpolations = 0;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === TICK) {
        return { start: start, end: j, body: src.slice(bodyStart, j), interpolations: interpolations, unterminated: false };
      }
      if (c === DOLLAR && src.charAt(j + 1) === '{') {
        interpolations++;
        j = scanExpression(j + 2);
        continue;
      }
      j++;
    }
    return { start: start, end: n, body: src.slice(bodyStart, n), interpolations: interpolations, unterminated: true };
  }

  function scanExpression(j) {
    var depth = 1;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; if (depth === 0) return j; continue; }
      if (c === '"' || c === "'") { j = skipQuoted(j, c); continue; }
      if (c === TICK) { var nested = scanTemplate(j); recordLiteral(nested); j = nested.end + 1; continue; }
      if (c === '/' && src.charAt(j + 1) === '/') { j = skipLineComment(j); continue; }
      if (c === '/' && src.charAt(j + 1) === '*') { j = skipBlockComment(j); continue; }
      if (c === '/' && regexAllowed(j)) { j = skipRegex(j); continue; }
      j++;
    }
    return j;
  }

  var i = 0;
  while (i < n) {
    var c = src.charAt(i);
    if (c === '/' && src.charAt(i + 1) === '/') { i = skipLineComment(i); continue; }
    if (c === '/' && src.charAt(i + 1) === '*') { i = skipBlockComment(i); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(i, c); continue; }
    if (c === TICK) { var lit = scanTemplate(i); recordLiteral(lit); i = lit.end + 1; continue; }
    if (c === '/' && regexAllowed(i)) { i = skipRegex(i); continue; }
    i++;
  }

  literals.sort(function (a, b) { return a.start - b.start; });
  var remap = {};
  literals.forEach(function (l, idx) { l.index = idx; remap[l.uid] = idx; });
  issues.forEach(function (iss) { iss.literal = remap[iss.literal]; });

  if (src.length > maxChars) {
    issues.push({
      type: 'payload-oversize',
      severity: 'error',
      literal: -1,
      start: 0,
      end: src.length,
      message: 'the payload itself is ' + src.length + ' characters, the safe limit is ' + maxChars
    });
  }

  var errors = issues.filter(function (x) { return x.severity === 'error'; });
  var ok = errors.length === 0;
  return {
    ok: ok,
    chars: src.length,
    lines: src.split('\n').length,
    literalCount: literals.length,
    literals: literals,
    issues: issues,
    errors: errors,
    maxChars: maxChars,
    maxLines: maxLines,
    strict: strict,
    summary: literals.length + ' template literal(s), ' + issues.length + ' issue(s)'
      + (ok ? '' : ', ' + errors.length + ' blocking')
  };
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
  escapeTemplateLiteral: escapeTemplateLiteral,
  unescapeTemplateLiteral: unescapeTemplateLiteral,
  isTemplateSafe: isTemplateSafe,
  planExecAppend: planExecAppend,
  detectReplyCapCutoff: detectReplyCapCutoff,
  planResumeAfterCutoff: planResumeAfterCutoff,
  planSeamRepair: planSeamRepair,
  scanTemplateLiterals: scanTemplateLiterals,
  main: main
};

