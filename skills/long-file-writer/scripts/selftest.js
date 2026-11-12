#!/usr/bin/env node
'use strict';

// Functional test for the long-file-writer skill.
//
// Proves the three acceptance properties:
//   1. a sample longer than 200 lines is split into parts of at most 120 lines;
//   2. the parts concatenate back to the exact original (no gap, no duplicate);
//   3. the read-back seam check reports success.
//
// Run: node skills/long-file-writer/scripts/selftest.js

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var skill = require('../index.js');
var execSync = require('child_process').execSync;

var MAX_LINES = 120;

// A sample that mixes prose, markdown headings and fenced code blocks.
function buildSample() {
  var out = [];
  out.push('# Sample document');
  out.push('');
  out.push('A sample that mixes prose, markdown headings and fenced code.');
  out.push('');
  for (var s = 1; s <= 12; s++) {
    out.push('## Section ' + s);
    out.push('');
    for (var i = 1; i <= 8; i++) {
      out.push('Section ' + s + ' line ' + i + ': filler sentence for the splitter.');
      if (i % 4 === 0) out.push('');
    }
    out.push('```js');
    out.push('function section' + s + '() {');
    out.push('  var value = ' + s + ';');
    out.push('  return value;');
    out.push('}');
    out.push('```');
    out.push('');
  }
  return out.join('\n') + '\n';
}

function roundTrip(text) {
  return skill.splitIntoParts(text).map(function (part) { return part.text; }).join('\n');
}

function run() {
  var sample = buildSample();
  var sampleLines = sample.split('\n').length;
  assert.ok(sampleLines > 200, 'sample must be longer than 200 lines, got ' + sampleLines);

  // --- 1. the splitter keeps every part within the line limit ---------------
  var parts = skill.splitIntoParts(sample);
  assert.ok(parts.length >= 2, 'sample must split into at least 2 parts, got ' + parts.length);
  parts.forEach(function (part, index) {
    assert.ok(part.lineCount <= MAX_LINES,
      'part ' + index + ' has ' + part.lineCount + ' lines, the limit is ' + MAX_LINES);
  });

  // --- 2. the parts concatenate back to the exact original ------------------
  var rejoined = parts.map(function (part) { return part.text; }).join('\n');
  assert.strictEqual(rejoined, sample, 'parts must concatenate back to the exact original');
  assert.strictEqual(rejoined.length, sample.length, 'the concatenated length must match');
  assert.strictEqual(rejoined.split('\n').length, sample.split('\n').length, 'the line count must match');
  var flat = [];
  parts.forEach(function (part) { flat = flat.concat(part.lines); });
  assert.strictEqual(flat.join('\n'), sample, 'the flattened parts must equal the original');

  // --- 3. write -> append -> read back -> verify ----------------------------
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-file-writer-'));
  var target = path.join(dir, 'sample.md');
  var report = skill.writeLongFile(target, sample);
  assert.ok(report.ok, 'writeLongFile must report ok, errors: ' + JSON.stringify(report.errors));
  assert.ok(report.partCount >= 2, 'the file must have been written in more than one part');
  assert.strictEqual(report.writes[0].mode, 'write', 'the first part must be written');
  assert.strictEqual(report.writes[1].mode, 'append', 'every later part must be appended');

  var verification = report.verification;
  assert.ok(verification.exactMatch, 'the read-back must match the intended content exactly');
  assert.strictEqual(verification.firstDifference, -1, 'there must be no difference at all');
  assert.ok(verification.delimiters.balanced,
    'the delimiters must be balanced: ' + JSON.stringify(verification.delimiters.problems));
  assert.ok(verification.seams.length >= 1, 'at least one seam must be verified');
  verification.seams.forEach(function (seam) {
    assert.ok(seam.ok, 'seam ' + seam.index + ' must be ok');
  });
  assert.strictEqual(verification.duplicates.length, 0, 'no duplicated line block is expected');
  assert.ok(verification.pageCount >= 1, 'the read-back must page through the file');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), sample, 'the file on disk must equal the original');

  // --- recovery: resume from the last successfully written boundary ----------
  var partial = path.join(dir, 'partial.md');
  fs.writeFileSync(partial, parts[0].text, 'utf8');
  var resumed = skill.writeLongFile(partial, sample, { resume: true });
  assert.ok(resumed.resumed, 'the writer must detect the existing boundary');
  assert.strictEqual(resumed.resumedFromPart, 1, 'the resume must continue at part 1');
  assert.ok(resumed.ok, 'the resumed write must verify: ' + JSON.stringify(resumed.errors));
  assert.strictEqual(fs.readFileSync(partial, 'utf8'), sample, 'the resumed file must equal the original');

  // --- atomic mode preserves the old target if a segmented write aborts -----
  var atomicTarget = path.join(dir, 'atomic.md');
  fs.writeFileSync(atomicTarget, 'known-good', 'utf8');
  assert.throws(function () {
    skill.writeLongFile(atomicTarget, sample, {
      atomic: true,
      onPart: function (part) {
        if (part.part === 1) throw new Error('simulated interrupted append');
      }
    });
  }, /simulated interrupted append/);
  assert.strictEqual(fs.readFileSync(atomicTarget, 'utf8'), 'known-good',
    'atomic failure must preserve the previous target');
  assert.strictEqual(fs.readdirSync(dir).filter(function (name) {
    return name.indexOf('atomic.md.segmented-') === 0;
  }).length, 0, 'atomic failure must remove its temporary file');
  var atomic = skill.writeLongFile(atomicTarget, sample, { atomic: true });
  assert.ok(atomic.ok && atomic.atomic, 'atomic write must verify before replacement');
  assert.strictEqual(fs.readFileSync(atomicTarget, 'utf8'), sample,
    'atomic success must replace the target with the verified content');

  // --- edge cases round trip exactly ----------------------------------------
  var edges = [
    '',
    'one line',
    'one line\n',
    'a\nb\nc\n',
    'trailing spaces   \n\n\nsecond block\n'
  ];
  edges.forEach(function (text) {
    assert.strictEqual(roundTrip(text), text, 'the round trip must be exact for: ' + JSON.stringify(text));
  });

  // --- code-mode exec safety ------------------------------------------------
  var TICK = '\x60';
  var DOLLAR = '\x24';

  var nasty = [
    '# Title',
    '',
    'inline ' + TICK + 'code' + TICK + ' and a ' + DOLLAR + '{expr} sequence',
    TICK + TICK + TICK + 'js',
    'const x = "double" and \'single\';',
    TICK + TICK + TICK,
    'a backslash \\ and a CRLF\r\nline',
    'unicode: 中文 é',
    ''
  ].join('\n');

  // escapeTemplateLiteral is round-trip safe
  var escaped = skill.escapeTemplateLiteral(nasty);
  assert.strictEqual(skill.unescapeTemplateLiteral(escaped), nasty,
    'unescapeTemplateLiteral must invert escapeTemplateLiteral');
  var cooked = new Function('return ' + TICK + escaped + TICK + ';')();
  assert.strictEqual(cooked, nasty,
    'the escaped text must evaluate back to the original inside a template literal');

  // the guard agrees: one literal, no unescaped backtick, no interpolation
  var guard = skill.scanTemplateLiterals(TICK + escaped + TICK);
  assert.ok(guard.ok, 'the escaped payload must pass the guard: ' + guard.summary);
  assert.strictEqual(guard.literalCount, 1, 'the guard must find exactly one literal');
  assert.strictEqual(guard.literals[0].unescapedBackticks, 0, 'no unescaped backtick may survive');
  assert.strictEqual(guard.literals[0].interpolations, 0, 'no interpolation may survive');

  // the guard catches the three failure modes
  var interpolated = skill.scanTemplateLiterals('var a = ' + TICK + 'x ' + DOLLAR + '{y} z' + TICK + ';');
  assert.ok(!interpolated.ok, 'an interpolation must block the payload');
  assert.ok(interpolated.issues.some(function (x) { return x.type === 'interpolation'; }),
    'the interpolation issue must be reported');

  var unterminated = skill.scanTemplateLiterals('var a = ' + TICK + 'never closed');
  assert.ok(!unterminated.ok, 'an unterminated literal must block the payload');
  assert.ok(unterminated.issues.some(function (x) { return x.type === 'unterminated'; }),
    'the unterminated issue must be reported');

  var nested = skill.scanTemplateLiterals('var a = ' + TICK + 'x ' + DOLLAR + '{ ' + TICK + 'y' + TICK + ' } z' + TICK + ';');
  assert.ok(!nested.ok, 'a nested template must block the payload');
  assert.ok(nested.issues.some(function (x) { return x.type === 'unescaped-backtick'; }),
    'the unescaped backtick issue must be reported');

  var oversize = skill.scanTemplateLiterals('var a = ' + TICK + new Array(300).join('x') + TICK + ';', { maxChars: 100 });
  assert.ok(!oversize.ok, 'an oversized literal must block the payload');
  assert.ok(oversize.issues.some(function (x) { return x.type === 'oversize-chars'; }),
    'the oversize issue must be reported');

  // --- the exec-append path: write the first segment, append the rest -------
  var longText = [];
  for (var rep = 0; rep < 6; rep++) longText.push(nasty);
  longText = longText.join('\n');

  var execTarget = path.join(dir, 'exec-append.md');
  var plan = skill.planExecAppend(execTarget, longText, { maxLines: 4, maxChars: 400 });
  assert.ok(plan.segmentCount >= 3, 'the plan must produce several segments, got ' + plan.segmentCount);
  assert.strictEqual(plan.segments.map(function (s) { return s.text; }).join(''), longText,
    'the segments must concatenate back to the original byte for byte');
  assert.strictEqual(plan.segments[0].mode, 'write', 'the first segment must be the write segment');
  assert.strictEqual(plan.segments[0].tool, 'write', 'the first segment must go to the write tool');
  plan.segments.forEach(function (seg) {
    assert.ok(seg.payload.length <= 400, 'segment ' + seg.index + ' must stay inside the size budget');
  });

  fs.writeFileSync(execTarget, plan.segments[0].payload, 'utf8');
  for (var si = 1; si < plan.segments.length; si++) {
    var seg = plan.segments[si];
    assert.strictEqual(seg.mode, 'append', 'every later segment must be an append');
    assert.strictEqual(seg.tool, 'exec', 'every later segment must go to exec');
    assert.strictEqual(seg.encoding, 'base64', 'the append payload must be base64 encoded');
    assert.ok(seg.templateSafe, 'the append command must be safe inside a template literal');
    assert.ok(/^python3 -c /.test(seg.payload), 'the append payload must be a python one-liner');
    var cmdGuard = skill.scanTemplateLiterals('await exec({ command: ' + TICK + seg.payload + TICK + ' });');
    assert.ok(cmdGuard.ok, 'the append command must pass the guard: ' + cmdGuard.summary);
    execSync(seg.payload);
  }

  var onDisk = fs.readFileSync(execTarget);
  assert.ok(onDisk.equals(Buffer.from(longText, 'utf8')),
    'the appended file must equal the original byte for byte');

  // planWrite can produce the same exec payloads
  var execPlan = skill.planWrite(execTarget, longText, { transport: 'exec', maxLines: 4, maxChars: 400 });
  assert.strictEqual(execPlan.transport, 'exec', 'planWrite must honour the exec transport');
  assert.strictEqual(execPlan.calls.length, plan.segmentCount, 'planWrite must return the same segment count');

  // --- the safety rule is part of the module contract ------------------------
  assert.ok(/never retry/i.test(skill.RECOVERY_RULE), 'the recovery rule must be exported');
  assert.ok(/resume/i.test(skill.RECOVERY_RULE), 'the recovery rule must mention resuming');

  // --- reply-cap cutoff detection -------------------------------------------
  var cutoffText = 'Error: the reply cap was reached. The output was truncated '
    + 'and the call was cut off before it completed.';
  var detected = skill.detectReplyCapCutoff(cutoffText);
  assert.ok(detected.cutoff, 'a truncated tool result must be detected');
  assert.ok(detected.confidence > 0.5, 'the detection must carry a confidence');
  assert.ok(/cutoff|cut-off|truncat/.test(detected.reason),
    'the reason must name the signal: ' + detected.reason);

  var okText = 'wrote 2 parts (241 lines), verified 1 seam, ok';
  var notDetected = skill.detectReplyCapCutoff(okText);
  assert.strictEqual(notDetected.cutoff, false,
    'a successful tool result must not look like a cutoff');
  assert.strictEqual(notDetected.confidence, 0,
    'a successful tool result carries no cutoff signal');
  assert.strictEqual(skill.detectReplyCapCutoff('no cutoff detected').cutoff, false,
    'a negated cutoff phrase must not trigger the recovery path');
  assert.strictEqual(skill.detectReplyCapCutoff('{"cutoff": false, "parts": 3}').cutoff, false,
    'a structured result that says cutoff:false must not trigger the recovery path');
  assert.ok(skill.detectReplyCapCutoff('the payload exceeds the maximum output length').cutoff,
    'an over-long payload must be detected');

  // --- the resume plan after a cutoff ---------------------------------------
  var resumeTarget = path.join(dir, 'cutoff.md');
  var resumeParts = skill.splitIntoParts(sample, { maxLines: 40, maxChars: 400 });
  var writtenSoFar = resumeParts.slice(0, 2).map(function (p) { return p.text; }).join('\n');
  fs.writeFileSync(resumeTarget, writtenSoFar, 'utf8');

  var resumePlan = skill.planResumeAfterCutoff(resumeTarget, sample, cutoffText,
    { maxLines: 40, maxChars: 400 });
  assert.ok(resumePlan.cutoff, 'the resume plan must know that a cutoff happened');
  assert.strictEqual(resumePlan.strategy, 'resume-at-part-boundary',
    'the plan must resume at the last successfully written boundary');
  assert.strictEqual(resumePlan.resumedFromPart, 2, 'the plan must continue at part 2');
  assert.ok(resumePlan.calls.length >= 1, 'the plan must produce at least one call');
  resumePlan.calls.forEach(function (call) {
    assert.strictEqual(call.mode, 'append', 'a continuation must only append');
    assert.strictEqual(call.tool, 'exec', 'a continuation must go through exec');
    assert.ok(call.payload.length <= 400, 'a continuation call must stay inside the size budget');
  });
  resumePlan.calls.forEach(function (call) { execSync(call.payload); });
  assert.strictEqual(fs.readFileSync(resumeTarget, 'utf8'), sample,
    'the continuation must rebuild the file byte for byte');
  assert.ok(skill.verifyReadBack(resumeTarget, sample).ok, 'the resumed file must verify');

  // no cutoff -> no plan, and the agent is told not to retry
  var noCutoffPlan = skill.planResumeAfterCutoff(resumeTarget, sample, okText);
  assert.strictEqual(noCutoffPlan.cutoff, false,
    'a successful tool result must not start a resume');
  assert.strictEqual(noCutoffPlan.calls.length, 0,
    'no calls may be produced without a cutoff');
  assert.ok(/do not re-split/.test(noCutoffPlan.next),
    'the plan must say why it did nothing');

  // the file was cut in the middle of a part: rewrite the prefix, append the rest
  var midTarget = path.join(dir, 'midcut.md');
  fs.writeFileSync(midTarget, resumeParts[0].text + '\n' + resumeParts[1].text.slice(0, 40), 'utf8');
  var midPlan = skill.planResumeAfterCutoff(midTarget, sample, cutoffText,
    { maxLines: 40, maxChars: 400 });
  assert.strictEqual(midPlan.strategy, 'rewrite-prefix-and-append',
    'a file cut in the middle of a part must be rewritten');
  fs.writeFileSync(midTarget, midPlan.calls[0].payload, 'utf8');
  midPlan.calls.slice(1).forEach(function (call) { execSync(call.payload); });
  assert.strictEqual(fs.readFileSync(midTarget, 'utf8'), sample,
    'the rewrite-and-append continuation must rebuild the file byte for byte');

  // --- the seam repair plan -------------------------------------------------
  var seamParts = skill.splitIntoParts(sample);
  var seamTarget = path.join(dir, 'seam.md');
  var dupLine = '';
  var dupIndex = -1;
  for (var q = seamParts[1].lines.length - 1; q >= 0; q--) {
    var cand = seamParts[1].lines[q];
    if (cand.trim().length < 4 || !/[A-Za-z]/.test(cand)) continue;
    dupLine = cand;
    dupIndex = q;
    break;
  }
  assert.ok(dupIndex >= 0, 'part 1 must offer a meaningful line to duplicate');
  var brokenLines = seamParts[0].lines.slice(0).concat([dupLine]);
  for (var w = 1; w < seamParts.length; w++) brokenLines = brokenLines.concat(seamParts[w].lines);
  var broken = brokenLines.join('\n');
  fs.writeFileSync(seamTarget, broken, 'utf8');

  var seamPlan = skill.planSeamRepair(seamTarget, sample, { maxLines: 40, maxChars: 400 });
  assert.ok(seamPlan.problem, 'the repair plan must report a problem');
  assert.strictEqual(seamPlan.problem.kind, 'duplicate-lines',
    'the problem must be the duplicated line: ' + JSON.stringify(seamPlan.problem));
  assert.ok(seamPlan.problem.seamIndex !== null, 'the problem must name the offending seam');
  assert.strictEqual(seamPlan.repair.kind, 'rewrite-prefix-and-append',
    'a duplicated span cannot be removed with an append, the prefix must be rewritten');
  assert.ok(seamPlan.calls.length >= 2, 'the repair must rewrite the prefix and append the rest');
  assert.strictEqual(seamPlan.calls[0].mode, 'rewrite', 'the first call must rewrite the prefix');
  assert.ok(seamPlan.verification && seamPlan.verification.fn === 'verifyReadBack',
    'the repair must name the verification step');

  fs.writeFileSync(seamTarget, seamPlan.calls[0].payload, 'utf8');
  seamPlan.calls.slice(1).forEach(function (call) { execSync(call.payload); });
  assert.strictEqual(fs.readFileSync(seamTarget, 'utf8'), sample,
    'the repair must restore the file byte for byte');
  assert.ok(skill.verifyReadBack(seamTarget, sample).ok, 'the repaired file must verify');

  // a missing tail is repaired with an append only
  var shortTarget = path.join(dir, 'short.md');
  var cutAt = sample.indexOf('\n## Section 6');
  assert.ok(cutAt > 0, 'the sample must have a section 6');
  var cut = sample.slice(0, cutAt);
  fs.writeFileSync(shortTarget, cut, 'utf8');
  var shortPlan = skill.planSeamRepair(shortTarget, sample, { maxLines: 40, maxChars: 400 });
  assert.strictEqual(shortPlan.problem.kind, 'missing-span',
    'a truncated file must be reported as a missing span: ' + JSON.stringify(shortPlan.problem));
  assert.strictEqual(shortPlan.repair.kind, 'append-missing-span',
    'a missing tail must be repaired with an append only');
  assert.strictEqual(shortPlan.calls[0].mode, 'append',
    'the append-only repair must not rewrite anything');
  shortPlan.calls.forEach(function (call) { execSync(call.payload); });
  assert.strictEqual(fs.readFileSync(shortTarget, 'utf8'), sample,
    'the append-only repair must restore the file byte for byte');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('long-file-writer selftest: OK (' + sampleLines + ' line sample, ' + parts.length + ' parts, ' + verification.seams.length + ' seams verified)');
  console.log('long-file-writer selftest: exec transport OK (' + plan.segmentCount + ' exec segments, ' + onDisk.length + ' bytes round trip)');
  return 0;
}

module.exports = { run: run, buildSample: buildSample };

if (require.main === module) {
  try {
    process.exit(run());
  } catch (err) {
    console.error('long-file-writer selftest FAILED: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  }
}
