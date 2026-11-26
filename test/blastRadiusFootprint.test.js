'use strict';
// Unit coverage for the constraint-counted-path ruler that measures the
// deliverable footprint of a GEP cycle (computeBlastRadius in
// src/gep/solidify.js).
//
// Cycle #0102: the ruler only recognised SOURCE-CODE paths, so a knowledge /
// analysis deliverable (.md doc, references/, SKILL.md, docs/, analysis/)
// measured 0 files and therefore could never be published as a Capsule.
// The ledger / bookkeeping (assets/gep/, logs/, memory/) must keep NOT
// counting so that solidify's own writes never inflate the footprint.
const test = require('node:test');
const assert = require('node:assert');

const {
  isConstraintCountedPath,
  readOpenclawConstraintPolicy,
} = require('../src/gep/solidify');

const policy = readOpenclawConstraintPolicy();

function counted(relPath) {
  return isConstraintCountedPath(relPath, policy);
}

test('knowledge-artifact paths are counted by the footprint ruler', () => {
  assert.strictEqual(counted('skills/foo/references/analysis.md'), true);
  assert.strictEqual(counted('docs/a.md'), true);
  assert.strictEqual(counted('analysis/b.txt'), true);
  assert.strictEqual(counted('skills/foo/SKILL.md'), true);
});

test('a knowledge file whose path mentions "capsule" is still counted', () => {
  // The previous bare /capsule/ exclude regex hid every such knowledge file.
  assert.strictEqual(counted('skills/foo/references/capsule-notes.md'), true);
});

test('ledger and bookkeeping paths are NOT counted', () => {
  assert.strictEqual(counted('assets/gep/genes.json'), false);
  assert.strictEqual(counted('assets/gep/capsules.json'), false);
  assert.strictEqual(counted('logs/run.log'), false);
  assert.strictEqual(counted('memory/x.md'), false);
});

test('source-code paths keep counting (unchanged behaviour)', () => {
  assert.strictEqual(counted('src/x.js'), true);
  assert.strictEqual(counted('scripts/run.sh'), true);
  assert.strictEqual(counted('config/app.yaml'), true);
  assert.strictEqual(counted('index.js'), true);
  assert.strictEqual(counted('package.json'), true);
});

test('the counted-file policy knows about knowledge artifacts', () => {
  for (const ext of ['.md', '.mdx', '.rst', '.txt', '.adoc']) {
    assert.ok(policy.includeExtensions.includes(ext), 'missing extension ' + ext);
  }
  for (const prefix of ['skills/', 'docs/', 'references/', 'analysis/']) {
    assert.ok(policy.includePrefixes.includes(prefix), 'missing prefix ' + prefix);
  }
  // The narrow ledger exclusion must not hide arbitrary knowledge files.
  assert.ok(policy.excludeRegex.includes('capsules?\\.json$'));
});
