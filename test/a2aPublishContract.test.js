// Publish contract tests (EvoMap GEP cycle #0101).
//
// The Hub rejects every capsule whose blast_radius.files is not >= 1 with
// "capsule_blast_radius_files_must_be_positive". The client used to send
// 0-file capsules (the local guard only enforced the upper bound) and the HTTP
// transport reported any HTTP status as ok:true, so a refused publish was
// logged as a success.
//
// These tests pin the contract down:
//   1. a 0-file capsule is NOT broadcast-eligible
//   2. a normal capsule IS broadcast-eligible (score >= 0.7, streak >= 2)
//   3. isBlastRadiusSafe keeps its upper-bound-only semantics
//   4. httpTransportSend surfaces a non-2xx Hub answer as ok:false

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  isBlastRadiusSafe,
  hasPositiveBlastRadius,
  isCapsuleBroadcastEligible,
} = require('../src/gep/a2a');
const { httpTransportSend } = require('../src/gep/a2aProtocol');

function successEvents(capsuleId) {
  return [
    { type: 'EvolutionEvent', id: 'evt_a', capsule_id: capsuleId, outcome: { status: 'success' } },
    { type: 'EvolutionEvent', id: 'evt_b', capsule_id: capsuleId, outcome: { status: 'success' } },
  ];
}

function makeCapsule(overrides) {
  return Object.assign({
    type: 'Capsule',
    schema_version: '1.6.0',
    id: 'capsule_contract_test',
    gene: 'gene_auto_c26ae3c2',
    trigger: ['bounty_task'],
    summary: 'publish contract test capsule',
    confidence: 0.9,
    outcome: { status: 'success', score: 0.9 },
    blast_radius: { files: 0, lines: 0 },
  }, overrides || {});
}

test('hasPositiveBlastRadius enforces the Hub lower bound (files >= 1)', () => {
  assert.strictEqual(hasPositiveBlastRadius({ files: 0, lines: 0 }), false);
  assert.strictEqual(hasPositiveBlastRadius({ files: -1, lines: 10 }), false);
  assert.strictEqual(hasPositiveBlastRadius({ files: 'x', lines: 10 }), false);
  assert.strictEqual(hasPositiveBlastRadius(null), false);
  assert.strictEqual(hasPositiveBlastRadius(undefined), false);
  assert.strictEqual(hasPositiveBlastRadius({ files: 1, lines: 0 }), true);
  assert.strictEqual(hasPositiveBlastRadius({ files: 2, lines: 50 }), true);
});

test('a capsule with blast_radius {files:0,lines:0} is NOT broadcast-eligible', () => {
  const capsule = makeCapsule({ id: 'capsule_zero_files', blast_radius: { files: 0, lines: 0 } });
  assert.strictEqual(isCapsuleBroadcastEligible(capsule, { events: successEvents(capsule.id) }), false);
});

test('a capsule with blast_radius {files:2,lines:50} IS broadcast-eligible', () => {
  const capsule = makeCapsule({ id: 'capsule_with_files', blast_radius: { files: 2, lines: 50 } });
  assert.strictEqual(isCapsuleBroadcastEligible(capsule, { events: successEvents(capsule.id) }), true);
});

test('isBlastRadiusSafe still returns true for a 0-file radius (upper-bound semantics unchanged)', () => {
  assert.strictEqual(isBlastRadiusSafe({ files: 0, lines: 0 }), true);
  assert.strictEqual(isBlastRadiusSafe({ files: 2, lines: 50 }), true);
});

test('httpTransportSend returns ok:false for a non-2xx response and exposes the Hub error body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'capsule_blast_radius_files_must_be_positive' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await httpTransportSend(
      { message_type: 'publish', payload: { capsule: { blast_radius: { files: 0, lines: 0 } } } },
      { hubUrl: 'http://127.0.0.1:' + port },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.ok(
      String(result.error).indexOf('capsule_blast_radius_files_must_be_positive') !== -1,
      'error must expose the Hub error code, got: ' + String(result.error),
    );
    assert.ok(result.response, 'the parsed Hub body must stay available under response');
    assert.strictEqual(result.response.error, 'capsule_blast_radius_files_must_be_positive');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('httpTransportSend keeps ok:true and the parsed body for a 2xx response', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, payload: { accepted: true } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await httpTransportSend(
      { message_type: 'publish', payload: { capsule: { blast_radius: { files: 2, lines: 50 } } } },
      { hubUrl: 'http://127.0.0.1:' + port },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.response.payload.accepted, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
