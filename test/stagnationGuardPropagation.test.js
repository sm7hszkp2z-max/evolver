const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { propagateStagnationSignal } = require('../src/evolve');
const { selectGeneAndCapsule } = require('../src/gep/selector');
const { buildGepPrompt } = require('../src/gep/prompt');

// The exact signal set cycle #0093 produced.
const PLATEAU_CYCLE_SIGNALS = ['external_task', 'repeated_tool_usage:exec'];

// The curated gene that ALREADY declares 'stable_success_plateau' in its
// signals_match. The fix must not touch that pattern -- the plateau reason
// only has to become a real cycle signal so the gene becomes selectable.
const CURATED_GENE_ID = 'gene_gep_innovate_from_opportunity';

function loadGenePool() {
  const file = path.join(__dirname, '..', 'assets', 'gep', 'genes.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const genes = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.genes) ? raw.genes : []);
  return genes.filter(function (g) { return g && g.type === 'Gene'; });
}

// Mirror of the guard block in src/evolve.js: the guard runs inside a
// try/catch that degrades to an 'ok' verdict, and the verdict is then
// pushed into the cycle signals.
function runGuardBlock(signals, guardImpl) {
  let stagnationVerdict = null;
  try {
    stagnationVerdict = guardImpl();
  } catch (e) {
    stagnationVerdict = { verdict: 'ok', reason: 'guard_error', stalled: false, redundant: false };
  }
  propagateStagnationSignal(signals, stagnationVerdict);
  return stagnationVerdict;
}

function select(signals) {
  return selectGeneAndCapsule({
    genes: loadGenePool(),
    capsules: [],
    signals: signals,
    memoryAdvice: null,
    driftEnabled: false,
    failedCapsules: [],
    history: [],
  });
}

function stalledVerdict() {
  return { verdict: 'stalled', stalled: true, redundant: false, reason: 'stable_success_plateau' };
}

describe('stagnation guard -> selector propagation', () => {
  it('selects nothing without the plateau signal (the cycle #0093 bug)', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    const result = select(signals);
    assert.equal(result.selectedGene, null);
  });

  it('turns a stalled verdict reason into a cycle signal', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    const verdict = runGuardBlock(signals, stalledVerdict);
    assert.equal(verdict.verdict, 'stalled');
    assert.ok(signals.includes('stable_success_plateau'), 'the plateau reason must become a cycle signal');
    assert.equal(signals.length, PLATEAU_CYCLE_SIGNALS.length + 1);
  });

  it('makes the curated plateau gene selectable once the signal is propagated', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    runGuardBlock(signals, stalledVerdict);
    const result = select(signals);
    assert.ok(result.selectedGene, 'a gene must be selected once the plateau signal is a real cycle signal');
    assert.equal(result.selectedGene.id, CURATED_GENE_ID);
    assert.ok(!/^gene_auto_/.test(result.selectedGene.id), 'must not be a freshly minted gene_auto_* gene');
  });

  it('shows the plateau signal in the prompt Context [Signals] block', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    runGuardBlock(signals, stalledVerdict);
    const prompt = buildGepPrompt({
      nowIso: '2026-11-19T00:00:00.000Z',
      context: 'test context',
      signals: signals,
      selector: { intent: 'innovate', reason: 'test' },
      parentEventId: 'evt_test',
      selectedGene: { id: CURATED_GENE_ID, strategy: ['do it'] },
      capsuleCandidates: [],
      genesPreview: [],
      capsulesPreview: [],
      capabilityCandidatesPreview: '(none)',
      externalCandidatesPreview: '(none)',
      cycleId: 93,
    });
    const block = prompt.split('Context [Signals]:')[1] || '';
    assert.ok(block.indexOf('stable_success_plateau') !== -1, 'the plateau signal must be visible to the executor');
  });

  it('adds no signal for an ok verdict and leaves the selection unchanged', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    const verdict = runGuardBlock(signals, function () {
      return { verdict: 'ok', stalled: false, redundant: false, reason: 'variance_above_threshold' };
    });
    assert.equal(verdict.verdict, 'ok');
    assert.deepEqual(signals, PLATEAU_CYCLE_SIGNALS);
    assert.equal(select(signals).selectedGene, null);
  });

  it('never duplicates a signal that is already present', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.concat(['stable_success_plateau']);
    runGuardBlock(signals, stalledVerdict);
    const occurrences = signals.filter(function (s) { return s === 'stable_success_plateau'; }).length;
    assert.equal(occurrences, 1);
  });

  it('leaves the signals array unmodified when the guard throws', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    const verdict = runGuardBlock(signals, function () {
      throw new Error('guard exploded');
    });
    assert.equal(verdict.verdict, 'ok');
    assert.equal(verdict.reason, 'guard_error');
    assert.deepEqual(signals, PLATEAU_CYCLE_SIGNALS);
    assert.equal(select(signals).selectedGene, null);
  });

  it('does not throw on a malformed verdict', () => {
    const signals = PLATEAU_CYCLE_SIGNALS.slice();
    assert.doesNotThrow(function () {
      propagateStagnationSignal(signals, { stalled: true, reason: null });
      propagateStagnationSignal(signals, { stalled: true, reason: '   ' });
      propagateStagnationSignal(signals, null);
      propagateStagnationSignal(null, { stalled: true, reason: 'stable_success_plateau' });
    });
    assert.deepEqual(signals, PLATEAU_CYCLE_SIGNALS);
  });
});
