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

describe('buildGepPrompt -- tool usage guardrails', () => {
  const cfgPath = require('node:path').resolve(__dirname, '..', '.evolver/gep/tool_usage_guardrails.json');

  it('embeds the Hub guardrails block when the config is present', () => {
    const prompt = build('0085');
    if (require('node:fs').existsSync(cfgPath)) {
      assert.ok(prompt.includes('Tool Usage Guardrails'), 'prompt must embed the guardrails block');
      assert.ok(prompt.includes('max 3 consecutive'), 'prompt must carry the exec limits');
      assert.ok(prompt.includes('.evolver/gep/tool_usage_guardrails.json'), 'prompt must name the guardrails source');
    } else {
      assert.ok(!prompt.includes('Tool Usage Guardrails'), 'no block without a config');
    }
  });

  it('never throws when the guardrails config is unreadable', () => {
    const { buildToolUsageGuardrailsBlock } = require('../src/gep/prompt');
    assert.doesNotThrow(() => buildToolUsageGuardrailsBlock());
  });
});

describe('buildHubMatchedBlock -- oversized hub payload', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { buildHubMatchedBlock } = require('../src/gep/prompt');
  const cfgPath = path.resolve(__dirname, '..', '.evolver/gep/tool_usage_guardrails.json');

  it('renders a valid, bounded payload without surviving truncation markers', () => {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const limit = cfg.hub_payload_max_chars;
    assert.ok(Number.isInteger(limit), 'hub_payload_max_chars must be an integer in the guardrails config');
    assert.ok(limit > 0, 'hub_payload_max_chars must be positive');

    const strategy = [
      'Analyze tool usage patterns and find the root cause of repetition',
      'Enforce exec limits and route ad-hoc script execution to registered tools',
      'Batch operations into single commands and deduplicate signals'
    ];
    const payload = {
      id: 'capsule_oversized_regression',
      gene: 'gene_gep_optimize_tool_usage',
      type: 'Capsule',
      asset_id: 'sha256:oversized-regression',
      summary: 'Oversized hub payload used by the payload cap regression test',
      strategy,
      anti_patterns: ['repeated exec calls without batching'],
      outcome: { status: 'success', score: 0.73 },
      trigger: ['repeated_tool_usage:exec', 'protocol_drift'],
      content: 'Gene: gene_gep_optimize_tool_usage (optimize)\n\n...[TRUNCATED]...\n' + 'x'.repeat(50000),
      env_fingerprint: { cwd: 'y'.repeat(5000) },
      success_reason: 'z'.repeat(5000)
    };

    const block = buildHubMatchedBlock({
      capsule: { payload, asset_id: payload.asset_id, confidence: 0.73 }
    });

    const match = block.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(match, 'hub block must embed a fenced json payload');
    const json = match[1];
    assert.ok(
      json.length <= limit,
      'rendered hub payload must stay within hub_payload_max_chars (got ' + json.length + ', limit ' + limit + ')'
    );
    let parsed = null;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      assert.fail('rendered hub payload must be valid JSON: ' + err.message);
    }
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'rendered hub payload must be a JSON object');
    assert.ok(!block.includes('[TRUNCATED]'), 'embedded truncation marker must not survive into the prompt');
    for (const step of strategy) {
      assert.ok(block.includes(step), 'hub strategy step must still be present: ' + step);
    }
  });
});
