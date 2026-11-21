const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeOutcomeScore } = require('../src/gep/solidify');

// Regression guard for the "stable_success_plateau" root cause:
// outcome.score used to be hardcoded to 0.85 on every successful cycle, so the
// StagnationGuard variance metric was structurally 0 and the plateau verdict
// carried no information. The score must now MOVE with the cycle evidence.

function profile(overrides) {
  const base = {
    validation: {
      ok: true,
      results: [
        { cmd: 'node scripts/validate-modules.js ./src/gep/solidify', ok: true }
      ]
    },
    constraintCheck: { ok: true, violations: [], warnings: [] },
    canary: { ok: true, skipped: false },
    protocolViolations: [],
    blast: { files: 2, lines: 71 },
    capsuleReuseRejected: null,
  };
  return Object.assign(base, overrides || {});
}

describe('computeOutcomeScore', function () {
  it('scores a fully passing cycle inside the publish band [0.78, 0.95]', function () {
    const score = computeOutcomeScore(profile());
    assert.ok(score >= 0.78, 'full pass must be >= 0.78 (publish gate), got ' + score);
    assert.ok(score <= 1, 'full pass must be <= 1, got ' + score);
    assert.ok(score <= 0.95, 'full pass must stay in the documented band, got ' + score);
  });

  it('keeps a full pass above the gate even for a very large blast radius', function () {
    const score = computeOutcomeScore(profile({
      blast: { files: 100, lines: 50000 },
    }));
    assert.ok(score >= 0.78, 'large blast must not drop a valid cycle below the gate, got ' + score);
  });

  it('scores a failing validation command below the gate but above zero', function () {
    const score = computeOutcomeScore(profile({
      validation: {
        ok: false,
        results: [
          { cmd: 'node scripts/validate-modules.js ./src/gep/solidify', ok: true },
          { cmd: 'node --test test/', ok: false }
        ]
      }
    }));
    assert.ok(score < 0.78, 'failing validation must score below the gate, got ' + score);
    assert.ok(score > 0, 'failing validation must still score above zero, got ' + score);
  });

  it('scores a failed cycle low enough to be excluded by the publish gate', function () {
    const score = computeOutcomeScore(profile({
      validation: { ok: false, results: [{ cmd: 'node --test test/', ok: false }] }
    }));
    assert.ok(score <= 0.2, 'failed cycle must score <= 0.2, got ' + score);
    assert.ok(score > 0, 'failed cycle must stay above zero, got ' + score);
  });

  it('scores constraint violations and protocol violations below a clean cycle', function () {
    const clean = computeOutcomeScore(profile());
    const withConstraintViolation = computeOutcomeScore(profile({
      constraintCheck: { ok: false, violations: ['max_files exceeded: 30 > 25'], warnings: [] }
    }));
    const withProtocolViolation = computeOutcomeScore(profile({
      protocolViolations: ['missing_or_invalid_mutation']
    }));
    assert.ok(withConstraintViolation < clean,
      'constraint violation must score lower than clean: ' + withConstraintViolation + ' vs ' + clean);
    assert.ok(withProtocolViolation < clean,
      'protocol violation must score lower than clean: ' + withProtocolViolation + ' vs ' + clean);
    assert.ok(withConstraintViolation <= 0.2, 'constraint violation must score <= 0.2');
    assert.ok(withProtocolViolation <= 0.2, 'protocol violation must score <= 0.2');
  });

  it('produces DIFFERENT scores for different evidence profiles (plateau regression guard)', function () {
    const small = computeOutcomeScore(profile());
    const large = computeOutcomeScore(profile({
      validation: {
        ok: true,
        results: [
          { cmd: 'a', ok: true },
          { cmd: 'b', ok: true },
          { cmd: 'c', ok: true },
          { cmd: 'd', ok: true }
        ]
      },
      blast: { files: 40, lines: 8000 }
    }));
    assert.notStrictEqual(small, large,
      'two different evidence profiles must not collapse into one constant score');
  });

  it('always returns a score inside [0, 1]', function () {
    const cases = [
      profile(),
      profile({ validation: { ok: false, results: [] } }),
      profile({ constraintCheck: { ok: false, violations: ['a', 'b', 'c'] } }),
      profile({ protocolViolations: ['x', 'y', 'z', 'w', 'v'] }),
      profile({ blast: { files: 10000, lines: 1000000 } }),
      profile({ canary: { ok: false, skipped: false } }),
      profile({ canary: { ok: true, skipped: true } }),
      profile({ capsuleReuseRejected: { reason: 'capsule_gene_mismatch' } }),
      profile({ validation: { ok: true, results: [] } }),
      profile({}),
    ];
    for (const c of cases) {
      const score = computeOutcomeScore(c);
      assert.ok(typeof score === 'number' && Number.isFinite(score), 'score must be a finite number');
      assert.ok(score >= 0 && score <= 1, 'score must be within [0, 1], got ' + score);
    }
  });
});
