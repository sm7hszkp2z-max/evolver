const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderSessionsSpawnCall,
  resolveBridgeAgentId,
  loadBridgeAgentAllowlist,
} = require('../src/gep/bridge');

function payloadOf(call) {
  assert.ok(call.startsWith('sessions_spawn('), 'call must start with sessions_spawn(');
  assert.ok(call.endsWith(')'), 'call must end with a closing paren');
  const raw = call.slice('sessions_spawn('.length, -1);
  return JSON.parse(raw);
}

describe('resolveBridgeAgentId', () => {
  it('keeps the requested id when it is allowed', () => {
    assert.equal(resolveBridgeAgentId({ requested: 'personal', allowed: ['personal'] }), 'personal');
    assert.equal(resolveBridgeAgentId({ requested: 'b', allowed: ['a', 'b'] }), 'b');
  });

  it('uses the first allowed id when the requested id is not allowed', () => {
    assert.equal(resolveBridgeAgentId({ requested: 'main', allowed: ['personal'] }), 'personal');
    assert.equal(resolveBridgeAgentId({ requested: 'main', allowed: ['personal', 'work'] }), 'personal');
  });

  it('keeps the requested id when no allowlist is available (backward compatible)', () => {
    assert.equal(resolveBridgeAgentId({ requested: 'main', allowed: [] }), 'main');
    assert.equal(resolveBridgeAgentId({ requested: 'main', allowed: undefined }), 'main');
    assert.equal(resolveBridgeAgentId({ requested: 'main' }), 'main');
  });
});

describe('loadBridgeAgentAllowlist', () => {
  it('reads a comma separated env list', () => {
    const ids = loadBridgeAgentAllowlist({
      env: { EVOLVER_BRIDGE_AGENT_IDS: 'personal, work' },
      repoRoot: '/nonexistent-root-for-tests',
    });
    assert.deepEqual(ids, ['personal', 'work']);
  });

  it('returns an empty allowlist when nothing is configured', () => {
    const ids = loadBridgeAgentAllowlist({
      env: {},
      repoRoot: '/nonexistent-root-for-tests',
    });
    assert.deepEqual(ids, []);
  });
});

describe('renderSessionsSpawnCall', () => {
  it('renders valid JSON that carries the resolved agent id', () => {
    const call = renderSessionsSpawnCall({
      task: 'apply the patch',
      agentId: 'main',
      allowedAgentIds: ['personal'],
      cleanup: 'delete',
      label: 'gep_bridge_0086',
    });
    const payload = payloadOf(call);
    assert.equal(payload.agentId, 'personal');
    assert.equal(payload.task, 'apply the patch');
    assert.equal(payload.cleanup, 'delete');
    assert.equal(payload.label, 'gep_bridge_0086');
  });

  it('keeps the requested agent id when no allowlist is provided', () => {
    const payload = payloadOf(
      renderSessionsSpawnCall({ task: 'x', agentId: 'main', cleanup: 'delete', label: 'gep_bridge' })
    );
    assert.equal(payload.agentId, 'main');
  });

  it('keeps an allowed agent id unchanged', () => {
    const payload = payloadOf(
      renderSessionsSpawnCall({
        task: 'x',
        agentId: 'personal',
        allowedAgentIds: ['personal'],
        cleanup: 'delete',
        label: 'gep_bridge',
      })
    );
    assert.equal(payload.agentId, 'personal');
  });
});
