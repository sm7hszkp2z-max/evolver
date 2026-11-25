#!/usr/bin/env node
// Publish contract validator (EvoMap GEP cycle #0101).
//
// Verifies the fix for the two defects that made a knowledge-only Capsule
// fail silently:
//
//   DEFECT 1 - the blast-radius guard had no lower bound, so a 0-file capsule
//              passed the local eligibility check and was shipped to the Hub,
//              which always rejects it with
//              "capsule_blast_radius_files_must_be_positive".
//   DEFECT 2 - the HTTP transport reported every HTTP status as ok:true, so a
//              rejected publish was logged as a success.
//
// Run: node validation/validate-publish-contract.js
// Exit code 0 = every check passed.

const fs = require('fs');
const path = require('path');
const http = require('http');

const repoRoot = path.resolve(__dirname, '..');
const a2a = require(path.join(repoRoot, 'src', 'gep', 'a2a'));
const a2aProtocol = require(path.join(repoRoot, 'src', 'gep', 'a2aProtocol'));

let failures = 0;
let passes = 0;

function assert(cond, msg) {
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

function successEvents(capsuleId) {
  return [
    { type: 'EvolutionEvent', id: 'evt_a', capsule_id: capsuleId, outcome: { status: 'success' } },
    { type: 'EvolutionEvent', id: 'evt_b', capsule_id: capsuleId, outcome: { status: 'success' } },
  ];
}

function makeCapsule(id, blastRadius) {
  return {
    type: 'Capsule',
    schema_version: '1.6.0',
    id: id,
    gene: 'gene_auto_c26ae3c2',
    trigger: ['bounty_task'],
    summary: 'publish contract validation capsule',
    confidence: 0.9,
    outcome: { status: 'success', score: 0.9 },
    blast_radius: blastRadius,
  };
}

// --- DEFECT 1: one home for the blast-radius lower bound --------------------

check('hasPositiveBlastRadius rejects a 0-file radius', function () {
  assert(a2a.hasPositiveBlastRadius({ files: 0, lines: 0 }) === false);
  assert(a2a.hasPositiveBlastRadius({ files: -3, lines: 5 }) === false);
  assert(a2a.hasPositiveBlastRadius(null) === false);
});

check('hasPositiveBlastRadius accepts files >= 1', function () {
  assert(a2a.hasPositiveBlastRadius({ files: 1, lines: 0 }) === true);
  assert(a2a.hasPositiveBlastRadius({ files: 2, lines: 50 }) === true);
});

check('a 0-file capsule is not broadcast-eligible', function () {
  const capsule = makeCapsule('capsule_validate_zero', { files: 0, lines: 0 });
  assert(a2a.isCapsuleBroadcastEligible(capsule, { events: successEvents(capsule.id) }) === false);
});

check('a capsule with files >= 1 and streak >= 2 is broadcast-eligible', function () {
  const capsule = makeCapsule('capsule_validate_ok', { files: 2, lines: 50 });
  assert(a2a.isCapsuleBroadcastEligible(capsule, { events: successEvents(capsule.id) }) === true);
});

check('isBlastRadiusSafe keeps its upper-bound-only semantics', function () {
  assert(a2a.isBlastRadiusSafe({ files: 0, lines: 0 }) === true);
  assert(a2a.isBlastRadiusSafe({ files: 2, lines: 50 }) === true);
});

check('solidify.js uses the shared predicate instead of a hand-rolled copy', function () {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'gep', 'solidify.js'), 'utf8');
  assert(src.indexOf('isCapsuleBroadcastEligible(') !== -1, 'shared predicate must be used');
  assert(src.indexOf('isBlastRadiusSafe(') === -1, 'hand-rolled upper-bound copy must be gone');
});

check('solidify.js records the explicit Hub error code on a skipped publish', function () {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'gep', 'solidify.js'), 'utf8');
  assert(src.indexOf('capsule_blast_radius_files_must_be_positive') !== -1);
  assert(src.indexOf('asset_publish_skip') !== -1);
});

check('solidify.js logs the real publish outcome inside the promise resolution', function () {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'gep', 'solidify.js'), 'utf8');
  const publishIdx = src.indexOf('httpTransportSend(msg');
  assert(publishIdx !== -1, 'auto-publish call not found');
  const logIdx = src.indexOf("action: 'asset_publish'", publishIdx);
  assert(logIdx !== -1, 'asset_publish log entry not found');
  const resolutionIdx = src.indexOf('.then(function (res)', publishIdx);
  assert(resolutionIdx !== -1, 'promise resolution not found');
  assert(logIdx > resolutionIdx, 'the asset_publish log entry must live inside the promise resolution');
});

// --- DEFECT 2: the HTTP transport must not swallow Hub rejections ----------

check('a2aProtocol.js checks the HTTP status before reporting success', function () {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'gep', 'a2aProtocol.js'), 'utf8');
  assert(src.indexOf('if (!res.ok)') !== -1, 'the transport must branch on res.ok');
  assert(src.indexOf('extractHubError') !== -1, 'the Hub error code must be extracted');
});

const httpChecks = [
  {
    name: 'httpTransportSend reports a Hub 4xx as ok:false and exposes the error body',
    status: 400,
    body: { error: 'capsule_blast_radius_files_must_be_positive' },
    expectOk: false,
    expectCode: 'capsule_blast_radius_files_must_be_positive',
  },
  {
    name: 'httpTransportSend keeps ok:true for a 2xx answer',
    status: 200,
    body: { ok: true, payload: { accepted: true } },
    expectOk: true,
    expectCode: null,
  },
];

function runHttpCheck(spec) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(function (req, res) {
      res.writeHead(spec.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(spec.body));
    });
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      a2aProtocol
        .httpTransportSend({ message_type: 'publish', payload: { capsule: {} } }, { hubUrl: 'http://127.0.0.1:' + port })
        .then(function (result) {
          server.close(function () {
            try {
              assert(result.ok === spec.expectOk, 'unexpected ok value: ' + JSON.stringify(result));
              if (spec.expectCode) {
                assert(
                  String(result.error).indexOf(spec.expectCode) !== -1,
                  'error must expose ' + spec.expectCode + ', got: ' + String(result.error),
                );
                assert(result.response && result.response.error === spec.expectCode, 'parsed body must stay available');
                assert(result.status === spec.status, 'status must be exposed, got: ' + String(result.status));
              } else {
                assert(result.response && result.response.payload.accepted === true, 'parsed body must be returned');
              }
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        })
        .catch(function (err) {
          server.close(function () { reject(err); });
        });
    });
  });
}

let chain = Promise.resolve();
httpChecks.forEach(function (spec) {
  chain = chain.then(function () {
    return runHttpCheck(spec).then(
      function () {
        passes += 1;
        console.log('PASS  ' + spec.name);
      },
      function (e) {
        failures += 1;
        console.error('FAIL  ' + spec.name + ': ' + (e && e.message ? e.message : e));
      },
    );
  });
});

chain.then(function () {
  console.log('');
  console.log('publish-contract validation: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures === 0 ? 0 : 1);
});
