// ---------------------------------------------------------------------------
// retry -- shared retry/backoff for outbound Hub HTTP calls.
// Every Hub A2A call used one AbortController timeout and never retried, so a
// transient network error / 5xx / 429 silently lost the Hub task claim, the
// Hub asset search and the heartbeat.
// Policy (adapted from the EvoMap "retryWithBackoff" reference asset):
//   transient -> network errors, our own AbortController timeout, HTTP 5xx and
//                HTTP 429 -> retried with exponential backoff
//   permanent -> other 4xx (400/401/403/404) -> short-circuit, never retried
//   Retry-After wins over the computed delay; every delay is capped; one
//   short "[Retry] ..." line per retry keeps the behaviour observable
// ---------------------------------------------------------------------------

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2000;

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN', 'ECONNREFUSED',
  'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function getConfig() {
  return {
    attempts: Math.max(1, envInt('HUB_RETRY_ATTEMPTS', DEFAULT_ATTEMPTS)),
    baseDelayMs: envInt('HUB_RETRY_BASE_MS', DEFAULT_BASE_DELAY_MS),
    maxDelayMs: envInt('HUB_RETRY_MAX_MS', DEFAULT_MAX_DELAY_MS),
  };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = String(name).toLowerCase();
  const key = Object.keys(headers).find(k => k.toLowerCase() === lower);
  return key ? headers[key] : null;
}

// "120" -> 120000ms, HTTP-date -> ms until that date, number -> ms.
function parseRetryAfter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, ts - Date.now());
}

function collectCodes(err) {
  const codes = [];
  let cur = err;
  for (let d = 0; d < 4 && cur && typeof cur === 'object'; d++) {
    for (const v of [cur.code, cur.errno]) if (v) codes.push(String(v).toUpperCase());
    if (cur.name && /abort|timeout/i.test(cur.name)) codes.push(String(cur.name).toUpperCase());
    cur = cur.cause;
  }
  return codes;
}

// Classify a failure -> { transient, reason, retryAfterMs }.
function classifyError(err) {
  // AbortController.abort(reason) makes fetch reject with the raw reason.
  if (typeof err === 'string') {
    return { transient: true, reason: /timeout/i.test(err) ? 'timeout' : 'abort', retryAfterMs: null };
  }
  if (!err || typeof err !== 'object') {
    return { transient: false, reason: 'unknown', retryAfterMs: null };
  }
  const status = Number(err.status || (err.response && err.response.status));
  if (Number.isFinite(status) && status > 0) {
    const headers = err.headers || (err.response && err.response.headers) || null;
    return {
      transient: status === 429 || status >= 500,
      reason: 'http_' + status,
      retryAfterMs: parseRetryAfter(headerValue(headers, 'retry-after')),
    };
  }
  const codes = collectCodes(err);
  if (codes.includes('ABORTERROR') || codes.includes('TIMEOUTERROR')) {
    return { transient: true, reason: 'timeout', retryAfterMs: null };
  }
  const netCode = codes.find(c => TRANSIENT_CODES.has(c));
  if (netCode) return { transient: true, reason: 'net_' + netCode.toLowerCase(), retryAfterMs: null };
  if (/fetch failed|socket hang up|timed? ?out/i.test(String(err.message || ''))) {
    return { transient: true, reason: 'network', retryAfterMs: null };
  }
  return { transient: false, reason: 'permanent', retryAfterMs: null };
}

function isTransientError(err) {
  return classifyError(err).transient;
}

function computeDelay(attempt, baseDelayMs, maxDelayMs, retryAfterMs) {
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    return Math.min(Math.max(0, retryAfterMs), maxDelayMs);
  }
  return Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultOnRetry(info) {
  console.log('[Retry] attempt=' + info.nextAttempt + '/' + info.attempts +
    ' delay=' + info.delayMs + 'ms reason=' + info.reason);
}

// Run fn with exponential backoff (100ms -> 200ms -> 400ms by default).
// Permanent failures are rethrown untouched; the last error is rethrown once
// the attempts are exhausted. Resolves to { value, attempts }.
async function retryWithBackoff(fn, opts) {
  const o = opts || {};
  const cfg = getConfig();
  let attempts = cfg.attempts;
  if (Number.isFinite(o.attempts)) attempts = Math.max(1, Math.floor(o.attempts));
  else if (Number.isFinite(o.retries)) attempts = Math.max(1, Math.floor(o.retries) + 1);
  const baseDelayMs = Number.isFinite(o.baseDelayMs) ? Math.max(0, o.baseDelayMs) : cfg.baseDelayMs;
  const maxDelayMs = Number.isFinite(o.maxDelayMs) ? Math.max(0, o.maxDelayMs) : cfg.maxDelayMs;
  const isTransient = typeof o.isTransient === 'function' ? o.isTransient : isTransientError;
  const sleep = typeof o.sleep === 'function' ? o.sleep : defaultSleep;
  const onRetry = typeof o.onRetry === 'function' ? o.onRetry : defaultOnRetry;

  let attempt = 0;
  while (attempt < attempts) {
    attempt += 1;
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      if (!isTransient(err) || attempt >= attempts) throw err;
      const cls = classifyError(err);
      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, cls.retryAfterMs);
      onRetry({ label: o.label || 'op', attempt, nextAttempt: attempt + 1, attempts,
        delayMs, reason: cls.reason, error: err });
      await sleep(delayMs);
    }
  }
  throw new Error('retryWithBackoff: attempts exhausted');
}

// Error carrying the HTTP status + headers so the retry layer can classify
// 5xx/429 as transient and read Retry-After.
function httpError(res) {
  const err = new Error('HTTP ' + (res && res.status) +
    (res && res.statusText ? ' ' + res.statusText : ''));
  err.status = res && res.status;
  err.headers = res && res.headers;
  err.response = res;
  err.isHttpError = true;
  return err;
}

// fetch() with a per-attempt AbortController timeout plus retry/backoff: each
// attempt gets its own timeout, the overall call gets the retries.
// Non-ok responses are returned as-is, except 5xx/429 which are retried.
async function fetchWithRetry(url, init, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 8000;
  const result = await retryWithBackoff(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(o.timeoutReason || 'request_timeout'), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
      if (res && !res.ok && (res.status === 429 || res.status >= 500)) throw httpError(res);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }, Object.assign({}, o, { label: o.label || 'fetch' }));
  return result.value;
}

module.exports = {
  retryWithBackoff,
  classifyError,
  isTransientError,
  fetchWithRetry,
  parseRetryAfter,
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
};
