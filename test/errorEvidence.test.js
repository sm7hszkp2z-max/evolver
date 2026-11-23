const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractSignals, pickErrorSignatureLine } = require('../src/gep/signals');
const hygiene = require('../skills/signal-hygiene');

const emptyInput = {
  recentSessionTranscript: '',
  todayLog: '',
  memorySnippet: '',
  userSnippet: '',
  recentEvents: [],
};

function hasSignal(signals, name) {
  return Array.isArray(signals) && signals.some(function (s) { return String(s).startsWith(name); });
}

// The exact shape of the stale line that dragged cycle #0098 into the repair
// gene: a toolResult from a PREVIOUS turn, quoted verbatim in the corpus.
const STALE_TOOL_RESULT =
  '**TOOLRESULT**: {"status":"failed","code":"invalid_input","failurePhase":"guest",' +
  '"replaySafe":false,"output":[],"error":"SyntaxError at openclaw-code-mode:user.js:36:1: ' +
  'Unterminated string constant"}';

const STALE_TOOL_RESULT_NO_WRAPPER =
  '2026-11-23T00:43:00.140Z toolResult {"status":"failed","code":"internal_error",' +
  '"failurePhase":"guest","output":[],"error":"ReferenceError: tools is not defined"}';

describe('error evidence -- a quoted or resolved failure is NOT live', function () {
  it('does not produce log_error for a quoted toolResult', function () {
    const r = extractSignals({ ...emptyInput, recentSessionTranscript: STALE_TOOL_RESULT });
    assert.ok(
      !hasSignal(r, 'log_error'),
      'a quoted toolResult must not fire log_error: ' + JSON.stringify(r)
    );
    assert.ok(
      !hasSignal(r, 'errsig:'),
      'a quoted toolResult must not produce an error signature: ' + JSON.stringify(r)
    );
  });

  it('does not produce log_error for a serialized payload without a wrapper', function () {
    const r = extractSignals({ ...emptyInput, recentSessionTranscript: STALE_TOOL_RESULT_NO_WRAPPER });
    assert.ok(
      !hasSignal(r, 'log_error'),
      'a serialized payload must not fire log_error: ' + JSON.stringify(r)
    );
  });

  it('does not produce log_error for an already-resolved failure', function () {
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'news-collect-reuters: status error, previously failed - it has been fixed',
    });
    assert.ok(
      !hasSignal(r, 'log_error'),
      'a resolved failure must not fire log_error: ' + JSON.stringify(r)
    );
  });

  it('the classifier reports the quoted artifact explicitly', function () {
    const v = hygiene.classifyErrorEvidence([STALE_TOOL_RESULT]);
    assert.equal(v.live, false);
    assert.equal(v.quoted, true);
    assert.equal(v.reason, 'quoted_artifact_only');
  });
});

describe('error evidence -- a direct failure statement is ALWAYS live', function () {
  const direct = [
    'error: cannot read file',
    '[error] TypeError: x is not a function',
    'exception: boom',
    'ReferenceError: tools is not defined',
  ];

  for (const line of direct) {
    it('produces log_error for: ' + line, function () {
      const r = extractSignals({ ...emptyInput, todayLog: line });
      assert.ok(
        hasSignal(r, 'log_error'),
        'a real failure must always fire log_error: ' + JSON.stringify(r)
      );
      assert.ok(
        hasSignal(r, 'errsig:'),
        'a real failure must always produce an error signature: ' + JSON.stringify(r)
      );
    });
  }

  it('a direct statement outside a quoted payload stays live', function () {
    const line = 'exec failed: error: cannot read file {"status":"failed"}';
    const r = extractSignals({ ...emptyInput, todayLog: line });
    assert.ok(hasSignal(r, 'log_error'), 'the prose failure must stay live: ' + JSON.stringify(r));
  });
});

describe('error evidence -- a success report is a success', function () {
  it('does not fire log_error when another component status is quoted', function () {
    const line = 'exec completed (quick-bl, code 0) :: reuters status error| delivery not-delivered| errs 2';
    const r = extractSignals({ ...emptyInput, todayLog: line });
    assert.ok(
      !hasSignal(r, 'log_error'),
      'a success report must not fire log_error: ' + JSON.stringify(r)
    );
  });

  it('the classifier reports the success report explicitly', function () {
    const v = hygiene.classifyErrorEvidence(['exec completed (code 0) :: reuters status error']);
    assert.equal(v.live, false);
    assert.equal(v.success, true);
  });
});

describe('error evidence -- coarse tag and fine signature always agree', function () {
  const corpora = [
    STALE_TOOL_RESULT,
    STALE_TOOL_RESULT_NO_WRAPPER,
    'error: cannot read file',
    '[error] TypeError: x is not a function',
    'exec completed (code 0) :: reuters status error',
    'news-collect-reuters: status error',
    'nothing interesting here',
  ];

  for (const line of corpora) {
    it('log_error and errsig agree for: ' + line.slice(0, 48), function () {
      const r = extractSignals({ ...emptyInput, recentSessionTranscript: line });
      const coarse = hasSignal(r, 'log_error');
      const fine = hasSignal(r, 'errsig:');
      assert.equal(
        coarse,
        fine,
        'the coarse tag and the fine signature must agree: ' + JSON.stringify(r)
      );
      const picked = pickErrorSignatureLine([line]);
      assert.equal(coarse, !!picked, 'pickErrorSignatureLine must agree too: ' + line);
    });
  }
});

describe('extractSignals -- the other signals are unchanged', function () {
  it('still detects a feature request', function () {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'Please add a dark mode toggle to the settings page.',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), JSON.stringify(r));
  });

  it('still detects a performance incident', function () {
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'lastErrorReason=timeout lastDiagnostics.summary="cron: job execution timed out"',
    });
    assert.ok(hasSignal(r, 'perf_bottleneck'), JSON.stringify(r));
  });

  it('still detects a repeated exec command', function () {
    const r = extractSignals({
      ...emptyInput,
      recentSessionTranscript:
        '**ASSISTANT**: a [TOOL: exec] [CMD: cat /tmp/scratch.json]\n' +
        '**ASSISTANT**: b [TOOL: exec] [CMD: cat /tmp/scratch.json]\n' +
        '**ASSISTANT**: c [TOOL: exec] [CMD: cat /tmp/scratch.json]',
    });
    assert.ok(hasSignal(r, 'repeated_tool_usage:exec'), JSON.stringify(r));
  });

  it('still detects a missing memory file', function () {
    const r = extractSignals({ ...emptyInput, todayLog: 'memory.md missing' });
    assert.ok(hasSignal(r, 'memory_missing'), JSON.stringify(r));
  });

  it('still detects protocol drift', function () {
    const r = extractSignals({ ...emptyInput, todayLog: 'the prompt template drifted' });
    assert.ok(hasSignal(r, 'protocol_drift'), JSON.stringify(r));
  });
});
