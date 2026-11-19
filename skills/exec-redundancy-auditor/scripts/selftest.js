#!/usr/bin/env node
'use strict';
// Self-test for skills/exec-redundancy-auditor -- real assertions; exits non-zero on failure.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skill = require('..');
const { extractExecCommands, normalizeCommand } = require('../../../src/gep/signals');

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name: name, err: err });
    console.error('  FAIL ' + name + ': ' + (err && err.message));
  }
}

// Inline fixture: one command executed three times, one command used once.
const FIXTURE = [
  '[TOOL: exec] [CMD: git status]',
  '[TOOL: exec] [CMD: git status]',
  '[TOOL: exec] [CMD: git status]',
  '[TOOL: exec] [CMD: node index.js run]'
].join('\n');

check('the repo extractor sees every fixture command', () => {
  assert.strictEqual(extractExecCommands(FIXTURE).length, 4);
});

check('auditCorpus counts the total exec calls', () => {
  assert.strictEqual(skill.auditCorpus(FIXTURE).totalCalls, 4);
});

check('auditCorpus counts the distinct commands', () => {
  assert.strictEqual(skill.auditCorpus(FIXTURE).distinctCommands, 2);
});

check('auditCorpus counts the repeated commands', () => {
  assert.strictEqual(skill.auditCorpus(FIXTURE).repeatedCount, 1);
});

check('auditCorpus computes the redundancy ratio', () => {
  assert.strictEqual(skill.auditCorpus(FIXTURE).redundancyRatio, 0.5);
});

check('auditCorpus lists the repeated command with its count', () => {
  const result = skill.auditCorpus(FIXTURE);
  assert.deepStrictEqual(result.repeated, [{ command: 'git status', count: 3 }]);
});

check('the benign watchdog command is skipped', () => {
  const corpus = '[TOOL: exec] [CMD: node scripts/watchdog.js ensure]';
  const result = skill.auditCorpus(corpus);
  assert.strictEqual(result.totalCalls, 0);
  assert.strictEqual(result.repeatedCount, 0);
  assert.deepStrictEqual(result.repeated, []);
});

check('minCount raises the repetition threshold', () => {
  const result = skill.auditCorpus(FIXTURE, { minCount: 4 });
  assert.strictEqual(result.totalCalls, 4);
  assert.strictEqual(result.repeatedCount, 0);
});

check('an empty corpus audits to zeroes', () => {
  const result = skill.auditCorpus('');
  assert.strictEqual(result.totalCalls, 0);
  assert.strictEqual(result.distinctCommands, 0);
  assert.strictEqual(result.repeatedCount, 0);
  assert.strictEqual(result.redundancyRatio, 0);
  assert.deepStrictEqual(result.repeated, []);
});

check('auditFiles merges several corpus files into one audit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-redundancy-'));
  try {
    const a = path.join(dir, 'a.log');
    const b = path.join(dir, 'b.log');
    fs.writeFileSync(a, '[TOOL: exec] [CMD: git status]\n');
    fs.writeFileSync(b, '[TOOL: exec] [CMD: git status]\n[TOOL: exec] [CMD: ls -la]\n');
    const merged = skill.auditFiles([a, b]);
    assert.strictEqual(merged.totalCalls, 3);
    assert.strictEqual(merged.distinctCommands, 2);
    assert.strictEqual(merged.repeatedCount, 1);
    assert.deepStrictEqual(merged.repeated, [{ command: 'git status', count: 2 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('formatReport renders the numbers and the repeated commands', () => {
  const report = skill.formatReport(skill.auditCorpus(FIXTURE));
  assert.ok(report.includes('exec calls'), report);
  assert.ok(report.includes('distinct commands'), report);
  assert.ok(report.includes('redundancy ratio'), report);
  assert.ok(report.includes('git status'), report);
});

check('collectMetrics emits Prometheus text', () => {
  const metrics = skill.collectMetrics(skill.auditCorpus(FIXTURE), { threshold: 0.1 });
  assert.ok(metrics.includes('# TYPE exec_redundancy_ratio gauge'), metrics);
  assert.ok(metrics.includes('exec_total_calls 4'), metrics);
  assert.ok(metrics.includes('exec_repeated_commands 1'), metrics);
  assert.ok(metrics.includes('exec_redundancy_alert 1'), metrics);
});

check('volatile parts are grouped by the repo normalizeCommand', () => {
  assert.strictEqual(normalizeCommand('sleep 5'), normalizeCommand('sleep 10'));
});

if (failures.length) {
  console.error('\n[selftest-exec-redundancy] ' + failures.length + ' check(s) failed');
  process.exit(1);
}
console.log('\n[selftest-exec-redundancy] all checks passed');
