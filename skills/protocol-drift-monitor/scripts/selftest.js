'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skill = require('..');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const assetsDir = path.join(repoRoot, 'assets', 'gep');
const genesStore = JSON.parse(fs.readFileSync(path.join(assetsDir, 'genes.json'), 'utf8'));
const capsulesStore = JSON.parse(fs.readFileSync(path.join(assetsDir, 'capsules.json'), 'utf8'));
const events = fs.readFileSync(path.join(assetsDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
assert(!Array.isArray(genesStore) && Array.isArray(genesStore.genes));
assert(!Array.isArray(capsulesStore) && Array.isArray(capsulesStore.capsules));

const monitor = new skill.ProtocolDriftMonitor({ windowMs: 60000 });
const realRecords = [...genesStore.genes, ...capsulesStore.capsules, ...events];
for (const record of realRecords) monitor.record(record);
monitor.record({ type: 'Gene', id: 7 });
const score = monitor.getDriftScore();
assert(score > 0 && score <= 1, `expected drift score in (0,1], got ${score}`);
const metrics = skill.collectDriftMetrics(monitor, { threshold: 0 });
assert(metrics.includes('# TYPE protocol_drift_score gauge'));
assert(metrics.includes('protocol_drift_alert 1'));

const snapshot = new skill.SchemaRegistrySnapshot({ assetsDir });
assert.strictEqual(Object.keys(snapshot.digests).length, 3);
snapshot.close();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-drift-'));
try {
  const recorder = new skill.DriftScoreRecorder({ file: path.join(tempDir, 'scores.jsonl') });
  recorder.record({ mismatch_ratio: score });
  assert(fs.readFileSync(recorder.file, 'utf8').includes('mismatch_ratio'));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const dryRun = skill.reconcileProtocolDrift();
assert.strictEqual(dryRun.dryRun, true);
assert.deepStrictEqual(dryRun.repaired, []);

const solidifySource = fs.readFileSync(path.join(repoRoot, 'src', 'gep', 'solidify.js'), 'utf8');
assert(/summary:\s*s\s*\|\|\s*autoSummary\s*\|\|/.test(solidifySource), 'fresh autoSummary must precede stale previous capsule summary');

console.log(`SELFTEST SUCCESS protocol-drift-monitor records=${realRecords.length} drift_score=${score.toFixed(6)}`);
console.log(metrics.trim());
