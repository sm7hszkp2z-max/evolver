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

  // --- the safety rule is part of the module contract ------------------------
  assert.ok(/never retry/i.test(skill.RECOVERY_RULE), 'the recovery rule must be exported');
  assert.ok(/resume/i.test(skill.RECOVERY_RULE), 'the recovery rule must mention resuming');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('long-file-writer selftest: OK (' + sampleLines + ' line sample, ' + parts.length + ' parts, ' + verification.seams.length + ' seams verified)');
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
