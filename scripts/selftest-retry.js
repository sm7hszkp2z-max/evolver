#!/usr/bin/env node
'use strict';
// Self-test for src/gep/retry.js -- real assertions; exits non-zero on failure.
const assert = require('assert');
const { retryWithBackoff, classifyError, isTransientError, fetchWithRetry } = require('../src/gep/retry');

const noSleep = () => Promise.resolve();
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.error('  FAIL ' + name + ': ' + (err && err.message));
  }
}

function httpErr(status, retryAfter) {
  const err = new Error('HTTP ' + status);
  err.status = status;
  err.headers = retryAfter === undefined ? null : new Headers({ 'retry-after': String(retryAfter) });
  return err;
}

function netErr(code) {
  const err = new Error('socket failure');
  err.code = code;
  return err;
}

(async () => {
  await check('transient error is retried and the operation then succeeds', async () => {
    let calls = 0;
    const res = await retryWithBackoff(async () => {
      calls += 1;
      if (calls === 1) throw netErr('ECONNRESET');
      return 'ok';
    }, { sleep: noSleep });
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(res.value, 'ok');
    assert.strictEqual(calls, 2);
  });

  await check('permanent error is NOT retried and propagates unchanged', async () => {
    let calls = 0;
    const boom = httpErr(403);
    let caught = null;
    try {
      await retryWithBackoff(async () => { calls += 1; throw boom; }, { sleep: noSleep });
    } catch (e) { caught = e; }
    assert.strictEqual(calls, 1);
    assert.strictEqual(caught, boom);
  });

  await check('default backoff is 100ms -> 200ms', async () => {
    const delays = [];
    await retryWithBackoff(async () => { throw netErr('ETIMEDOUT'); },
      { sleep: async (ms) => { delays.push(ms); }, attempts: 3 }).catch(() => {});
    assert.deepStrictEqual(delays, [100, 200]);
  });

  await check('backoff delays are monotonic and capped', async () => {
    const delays = [];
    await retryWithBackoff(async () => { throw netErr('ECONNRESET'); },
      { sleep: async (ms) => { delays.push(ms); }, attempts: 4, baseDelayMs: 100, maxDelayMs: 250 }).catch(() => {});
    assert.deepStrictEqual(delays, [100, 200, 250]);
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], 'delays must be monotonic');
    }
    assert.ok(delays.every(d => d <= 250), 'delays must be capped');
  });

  await check('Retry-After is honoured when present', async () => {
    const delays = [];
    await retryWithBackoff(async () => { throw httpErr(429, '1'); },
      { sleep: async (ms) => { delays.push(ms); }, attempts: 2 }).catch(() => {});
    assert.deepStrictEqual(delays, [1000]);
  });

  await check('HTTP 5xx/429 are transient, other 4xx are permanent', () => {
    assert.strictEqual(isTransientError(httpErr(500)), true);
    assert.strictEqual(isTransientError(httpErr(429)), true);
    assert.strictEqual(isTransientError(httpErr(400)), false);
    assert.strictEqual(isTransientError(httpErr(404)), false);
    assert.strictEqual(classifyError(httpErr(503)).reason, 'http_503');
  });

  await check('abort / timeout errors are transient', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    assert.strictEqual(isTransientError(abort), true);
    assert.strictEqual(classifyError(abort).reason, 'timeout');
    assert.strictEqual(isTransientError('request_timeout'), true);
    assert.strictEqual(classifyError('request_timeout').reason, 'timeout');
  });

  await check('fetchWithRetry retries a 5xx and returns the final response', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 503, statusText: 'Unavailable', headers: new Headers() };
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers() };
    };
    try {
      const res = await fetchWithRetry('http://example.invalid/x', { method: 'POST' }, { sleep: noSleep });
      assert.strictEqual(calls, 3);
      assert.strictEqual(res.ok, true);
    } finally {
      global.fetch = original;
    }
  });

  if (failures.length) {
    console.error('\n[selftest-retry] ' + failures.length + ' check(s) failed');
    process.exit(1);
  }
  console.log('\n[selftest-retry] all checks passed');
})();
