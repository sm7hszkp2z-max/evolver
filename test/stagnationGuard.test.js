const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectPlateau,
  detectRedundantAsset,
  guard,
  formatVerdict
} = require('../src/gep/stagnationGuard');

// The asset matched in cycle #0092. It is used here as a fixture id only.
const CYCLE_0092_ASSET = 'sha256:e8b9eca2159a6bb09354917e6484f8999bad4e52179560bb7d8dd97d8e6734d5';

function event(status, score) {
  return {
    type: 'EvolutionEvent',
    id: 'evt_' + status + '_' + score,
    intent: 'optimize',
    signals: ['external_task'],
    genes_used: ['gene_x'],
    outcome: { status: status, score: score }
  };
}

function tmpTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gep-stagnation-'));
  Object.keys(files).forEach(function (rel) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  });
  return dir;
}

describe('detectPlateau -- stable success plateau', () => {
  it('flags a history of identical successful cycles as a plateau', () => {
    const history = [];
    for (let i = 0; i < 8; i++) history.push(event('success', 0.85));
    const r = detectPlateau(history);
    assert.equal(r.stalled, true);
    assert.equal(r.reason, 'stable_success_plateau');
    assert.equal(r.window, 8);
    assert.equal(r.consecutiveStalled, 8);
    assert.ok(r.variance < 0.01, 'variance should be ~0, got ' + r.variance);
  });

  it('does not flag a history that contains a failed cycle', () => {
    const history = [
      event('success', 0.85),
      event('success', 0.85),
      event('success', 0.85),
      event('failed', 0.2),
      event('success', 0.85),
      event('success', 0.85)
    ];
    const r = detectPlateau(history);
    assert.equal(r.stalled, false);
    assert.equal(r.reason, 'recent_failure');
  });

  it('does not flag a history whose scores vary too much', () => {
    const history = [
      event('success', 0.2),
      event('success', 0.9),
      event('success', 0.5),
      event('success', 0.7),
      event('success', 0.3),
      event('success', 0.95)
    ];
    const r = detectPlateau(history);
    assert.equal(r.stalled, false);
    assert.equal(r.reason, 'variance_above_threshold');
    assert.ok(r.variance >= 0.01, 'variance should be >= 0.01, got ' + r.variance);
  });

  it('needs at least 5 cycles before it can call a plateau', () => {
    const history = [event('success', 0.85), event('success', 0.85), event('success', 0.85)];
    const r = detectPlateau(history);
    assert.equal(r.stalled, false);
    assert.equal(r.reason, 'not_enough_cycles');
  });

  it('survives an empty history', () => {
    const r = detectPlateau([]);
    assert.equal(r.stalled, false);
    assert.equal(r.reason, 'no_history');
  });
});

describe('detectRedundantAsset -- the matched asset is already in the tree', () => {
  it('flags an asset id that is present in the tree', () => {
    const dir = tmpTree({
      'src/thing.js': 'const x = 1; // ' + CYCLE_0092_ASSET + '\n',
      'README.md': '# hello\n'
    });
    const r = detectRedundantAsset(CYCLE_0092_ASSET, { root: dir });
    assert.equal(r.redundant, true);
    assert.equal(r.reason, 'asset_already_present');
    assert.ok(r.paths.length >= 1);
    assert.ok(r.paths.some(function (p) { return p.indexOf('thing.js') !== -1; }), JSON.stringify(r.paths));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not flag an asset id that is missing from the tree', () => {
    const dir = tmpTree({
      'src/thing.js': 'const x = 1;\n',
      'README.md': '# hello\n'
    });
    const r = detectRedundantAsset(CYCLE_0092_ASSET, { root: dir });
    assert.equal(r.redundant, false);
    assert.equal(r.reason, 'asset_not_found');
    assert.deepEqual(r.paths, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports no_asset_id for an empty id', () => {
    const r = detectRedundantAsset('', { root: os.tmpdir() });
    assert.equal(r.redundant, false);
    assert.equal(r.reason, 'no_asset_id');
  });
});

describe('guard -- combined verdict', () => {
  it('returns ok for a healthy history and an unknown asset', () => {
    const dir = tmpTree({ 'a.js': 'var a = 1;\n' });
    const history = [];
    for (let i = 0; i < 6; i++) history.push(event('success', 0.3 + i * 0.1));
    const v = guard(history, 'sha256:does_not_exist_anywhere', { root: dir });
    assert.equal(v.verdict, 'ok');
    assert.equal(v.stalled, false);
    assert.equal(v.redundant, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns redundant-asset when the matched asset is already in the tree', () => {
    const dir = tmpTree({ 'a.js': '// ' + CYCLE_0092_ASSET + '\n' });
    const history = [];
    for (let i = 0; i < 6; i++) history.push(event('success', 0.3 + i * 0.1));
    const v = guard(history, CYCLE_0092_ASSET, { root: dir });
    assert.equal(v.verdict, 'redundant-asset');
    assert.equal(v.redundant, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns stalled when the history sits in a stable success plateau', () => {
    const dir = tmpTree({ 'a.js': 'var a = 1;\n' });
    const history = [];
    for (let i = 0; i < 6; i++) history.push(event('success', 0.85));
    const v = guard(history, 'sha256:does_not_exist_anywhere', { root: dir });
    assert.equal(v.verdict, 'stalled');
    assert.equal(v.stalled, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('formats one clear line that starts with [StagnationGuard]', () => {
    const line = formatVerdict({ verdict: 'ok', reason: 'not_enough_cycles', asset_id: null, plateau: { window: 2, consecutiveStalled: 2, variance: 0 } });
    assert.ok(line.startsWith('[StagnationGuard]'), line);
    assert.ok(line.indexOf('verdict=ok') !== -1, line);
  });
});
