#!/usr/bin/env node
// Analysis-capsule footprint validator (EvoMap GEP cycle #0102).
//
// The Hub rejects every capsule whose blast_radius.files is not >= 1 with
// "capsule_blast_radius_files_must_be_positive". Before this cycle the client
// measured its own deliverable with a SOURCE-CODE-ONLY ruler, so a cycle that
// produced a knowledge / analysis artifact (and no source change) measured
// 0 files and could never publish.
//
// This validator proves the behaviour end to end on a throwaway git repo:
//   (a) a knowledge-only deliverable measures files >= 1 and is publishable
//   (b) a ledger-only change still measures 0 files (bookkeeping never
//       inflates the footprint)
//   (c) a source-only change still measures exactly 1 file
//
// Run: node validation/validate-analysis-capsule-footprint.js
// Exit code 0 = every check passed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const nodeAssert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const solidify = require(path.join(repoRoot, 'src', 'gep', 'solidify'));
const a2a = require(path.join(repoRoot, 'src', 'gep', 'a2a'));

const computeBlastRadius = solidify.computeBlastRadius;
const hasPositiveBlastRadius = a2a.hasPositiveBlastRadius;

let failures = 0;
let passes = 0;

function expect(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function check(name, fn) {
  try {
    fn();
    passes += 1;
    console.log('PASS  ' + name);
  } catch (e) {
    failures += 1;
    console.error('FAIL  ' + name + ': ' + (e && e.message ? e.message : e));
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function resetRepo(root) {
  git(root, ['reset', '--hard', '-q']);
  git(root, ['clean', '-fdq']);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gep-analysis-capsule-'));
console.log('temp repo: ' + tmpRoot);

try {
  git(tmpRoot, ['init', '-q']);
  git(tmpRoot, ['config', 'user.email', 'validator@example.com']);
  git(tmpRoot, ['config', 'user.name', 'gep-validator']);
  writeFile(tmpRoot, 'README.md', '# baseline\n');
  git(tmpRoot, ['add', '-A']);
  git(tmpRoot, ['commit', '-q', '-m', 'baseline']);

  // (a) knowledge / analysis-only deliverable
  writeFile(tmpRoot, 'skills/demo/references/analysis.md', '# analysis\n\nFindings.\n');
  const knowledgeBlast = computeBlastRadius({ repoRoot: tmpRoot, baselineUntracked: [] });
  console.log('knowledge-only blast: files=' + knowledgeBlast.files + ' lines=' + knowledgeBlast.lines);
  check('knowledge-only change measures files >= 1', () => {
    expect(
      knowledgeBlast.files >= 1,
      'expected files >= 1, got ' + knowledgeBlast.files
    );
  });
  check('knowledge-only change satisfies the Hub blast-radius lower bound', () => {
    nodeAssert.strictEqual(hasPositiveBlastRadius(knowledgeBlast), true);
  });
  check('knowledge-only change reports the knowledge file as counted', () => {
    nodeAssert.ok(
      (knowledgeBlast.changed_files || []).indexOf('skills/demo/references/analysis.md') !== -1,
      'expected the knowledge file in changed_files, got ' + JSON.stringify(knowledgeBlast.changed_files)
    );
  });

  // (b) ledger / bookkeeping-only change must NOT inflate the footprint
  resetRepo(tmpRoot);
  writeFile(tmpRoot, 'assets/gep/genes.json', '{"version":1,"genes":[]}\n');
  const ledgerBlast = computeBlastRadius({ repoRoot: tmpRoot, baselineUntracked: [] });
  console.log('ledger-only blast: files=' + ledgerBlast.files + ' lines=' + ledgerBlast.lines);
  check('ledger-only change measures 0 files', () => {
    nodeAssert.strictEqual(ledgerBlast.files, 0, 'expected files === 0, got ' + ledgerBlast.files);
  });
  check('ledger-only change stays ineligible for broadcast', () => {
    nodeAssert.strictEqual(hasPositiveBlastRadius(ledgerBlast), false);
  });

  // (c) source-only change still counts
  resetRepo(tmpRoot);
  writeFile(tmpRoot, 'src/x.js', 'module.exports = 1;\n');
  const sourceBlast = computeBlastRadius({ repoRoot: tmpRoot, baselineUntracked: [] });
  console.log('source-only blast: files=' + sourceBlast.files + ' lines=' + sourceBlast.lines);
  check('source-only change measures exactly 1 file', () => {
    nodeAssert.strictEqual(sourceBlast.files, 1, 'expected files === 1, got ' + sourceBlast.files);
  });
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log('temp repo removed: ' + tmpRoot);
  } catch (e) {
    console.error('WARN  failed to remove temp repo ' + tmpRoot + ': ' + e.message);
  }
}

console.log('---');
console.log('passes=' + passes + ' failures=' + failures);
if (failures > 0) process.exit(1);
console.log('ALL CHECKS PASSED');
