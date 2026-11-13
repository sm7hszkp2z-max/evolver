const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildGepPrompt, resolveStatusCycleTag } = require('../src/gep/prompt');

function build(cycleId) {
  return buildGepPrompt({
    nowIso: '2026-11-14T00:00:00.000Z',
    context: 'test context',
    signals: ['external_task'],
    selector: { intent: 'repair', reason: 'test' },
    parentEventId: 'evt_test',
    selectedGene: { id: 'gene_test', strategy: ['do it'] },
    capsuleCandidates: [],
    genesPreview: [],
    capsulesPreview: [],
    capabilityCandidatesPreview: '(none)',
    externalCandidatesPreview: '(none)',
    cycleId,
  });
}

describe('buildGepPrompt -- status file name contract', () => {
  let savedTag;

  before(() => {
    savedTag = process.env.EVOLVE_CYCLE_TAG;
    delete process.env.EVOLVE_CYCLE_TAG;
  });

  after(() => {
    if (savedTag === undefined) delete process.env.EVOLVE_CYCLE_TAG;
    else process.env.EVOLVE_CYCLE_TAG = savedTag;
  });

  it('never emits status_undefined', () => {
    const prompt = build(undefined);
    assert.ok(!prompt.includes('status_undefined'), 'prompt must not contain status_undefined');
    assert.ok(!prompt.includes('status_null'), 'prompt must not contain status_null');
  });

  it('emits the cycle-tagged status file name the wrapper reads', () => {
    const prompt = build('0083');
    assert.ok(prompt.includes('status_0083.json'), 'prompt must name the wrapper-visible status file');
    assert.ok(!prompt.includes('status_undefined'));
  });

  it('falls back to a safe literal name when no cycle id is available', () => {
    const prompt = build(undefined);
    assert.ok(prompt.includes('status_unknown.json'), 'fallback must be a safe literal name');
  });
});

describe('resolveStatusCycleTag', () => {
  it('normalizes "Cycle #0083" to 0083', () => {
    assert.equal(resolveStatusCycleTag('Cycle #0083'), '0083');
  });

  it('pads a bare number to four digits', () => {
    assert.equal(resolveStatusCycleTag('83'), '0083');
  });

  it('never returns undefined or null for a missing cycle id', () => {
    const saved = process.env.EVOLVE_CYCLE_TAG;
    delete process.env.EVOLVE_CYCLE_TAG;
    const tag = resolveStatusCycleTag(undefined);
    if (saved === undefined) delete process.env.EVOLVE_CYCLE_TAG;
    else process.env.EVOLVE_CYCLE_TAG = saved;
    assert.ok(tag, 'tag must be a non-empty string');
    assert.notEqual(tag, 'undefined');
    assert.notEqual(tag, 'null');
  });
});
