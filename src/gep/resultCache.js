// ---------------------------------------------------------------------------
// resultCache -- TTL result cache for repeated EvoMap probes.
//
// Hub reference asset
// (sha256:bba8e1ccb28afc17bd7a54bd3a5a5bd393d529ba17c36eb31175943bff67a169):
// "Implement a TTL-based result cache layer to eliminate redundant exec calls
//  in the agent heartbeat pipeline."
// Strategy: detect repeated calls for the same resource inside the cache TTL
// window and wrap every EvoMap API call / filesystem read in a cached()/store()
// pair with a per-operation TTL.
//
// Guarantees:
//   - a missing or corrupt cache file is a MISS, never an exception
//   - writes are atomic (temp file + rename)
//   - no absolute path is hardcoded; everything resolves through paths.js
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

// Default TTLs per operation type (milliseconds).
const TTL_DEFAULTS = {
  heartbeat: 240000,    // 4 min  - heartbeat / skills inventory probes
  health: 240000,       // 4 min  - health probes
  credentials: 3600000, // 1 h    - credential lookups
  completion: 60000,    // 1 min  - completion status
};

const CACHE_VERSION = 1;
const CACHE_FILE_NAME = 'result-cache.json';

let _state = null; // { version, entries: { key: { value, storedAt, expiresAt } } }

function ttlFor(kind) {
  const v = TTL_DEFAULTS[kind];
  return typeof v === 'number' && v > 0 ? v : TTL_DEFAULTS.heartbeat;
}

function getCacheDir() {
  if (typeof paths.getCacheDir === 'function') return paths.getCacheDir();
  return path.join(paths.getWorkspaceRoot(), 'cache');
}

function getCacheFile() {
  return path.join(getCacheDir(), CACHE_FILE_NAME);
}

function emptyState() {
  // Null prototype: cache keys come from callers and must not be able to
  // reach Object.prototype.
  return { version: CACHE_VERSION, entries: Object.create(null) };
}

function load() {
  if (_state) return _state;
  _state = emptyState();
  try {
    const file = getCacheFile();
    if (!fs.existsSync(file)) return _state;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) return _state;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return _state;
    const entries = parsed.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return _state;
    for (const key of Object.keys(entries)) {
      const entry = entries[key];
      if (!entry || typeof entry !== 'object') continue;
      if (!Object.prototype.hasOwnProperty.call(entry, 'value')) continue;
      _state.entries[key] = {
        value: entry.value,
        storedAt: Number(entry.storedAt) || 0,
        expiresAt: Number(entry.expiresAt) || 0,
      };
    }
  } catch (e) {
    // Missing or corrupt cache file -> treat the cache as empty. Never throw.
    _state = emptyState();
  }
  return _state;
}

function isFresh(entry, ttlMs) {
  if (!entry) return false;
  const now = Date.now();
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
    return entry.storedAt + ttlMs > now;
  }
  return entry.expiresAt > now;
}

// lookup(key, ttlMs) -> { hit: boolean, value: any }
function lookup(key, ttlMs) {
  const state = load();
  const k = String(key);
  if (!Object.prototype.hasOwnProperty.call(state.entries, k)) {
    return { hit: false, value: undefined };
  }
  const entry = state.entries[k];
  if (!isFresh(entry, ttlMs)) return { hit: false, value: undefined };
  return { hit: true, value: entry.value };
}

// cached(key, ttlMs) -> the cached value, or undefined on a miss.
// A stored value of null is a valid hit; use lookup() when null matters.
function cached(key, ttlMs) {
  const found = lookup(key, ttlMs);
  return found.hit ? found.value : undefined;
}

function prune(state, now) {
  for (const key of Object.keys(state.entries)) {
    const entry = state.entries[key];
    if (!entry || entry.expiresAt <= now) delete state.entries[key];
  }
}

function persist(state) {
  let tmp = null;
  try {
    const dir = getCacheDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best effort */ }
    const file = path.join(dir, CACHE_FILE_NAME);
    tmp = path.join(dir, CACHE_FILE_NAME + '.tmp-' + process.pid + '-' + Date.now());
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atomic replace
    return true;
  } catch (e) {
    // Persistence is best effort: a broken cache must never break a caller.
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } }
    return false;
  }
}

// store(key, value, ttlMs) -> boolean
function store(key, value, ttlMs) {
  const ttl = (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0)
    ? ttlMs
    : ttlFor('heartbeat');
  const state = load();
  const now = Date.now();
  state.entries[String(key)] = {
    value: value === undefined ? null : value,
    storedAt: now,
    expiresAt: now + ttl,
  };
  prune(state, now);
  persist(state);
  return true;
}

// invalidate(key) -> boolean
function invalidate(key) {
  const state = load();
  const k = String(key);
  if (!Object.prototype.hasOwnProperty.call(state.entries, k)) return false;
  delete state.entries[k];
  persist(state);
  return true;
}

function clear() {
  const state = load();
  state.entries = Object.create(null);
  persist(state);
}

// memoize(key, ttlMs, producer) -- the cached()/store() pair in one call.
// Returns the cached value inside the TTL window, otherwise computes it,
// stores it and returns it.
function memoize(key, ttlMs, producer) {
  if (typeof producer !== 'function') {
    throw new TypeError('memoize(key, ttlMs, producer) needs a producer function');
  }
  const found = lookup(key, ttlMs);
  if (found.hit) return found.value;
  const value = producer();
  store(key, value, ttlMs);
  return value;
}

function stats() {
  const state = load();
  const keys = Object.keys(state.entries);
  const now = Date.now();
  let fresh = 0;
  for (const k of keys) {
    const entry = state.entries[k];
    if (entry && entry.expiresAt > now) fresh++;
  }
  return { file: getCacheFile(), entries: keys.length, fresh: fresh };
}

module.exports = {
  TTL_DEFAULTS,
  cached,
  store,
  lookup,
  invalidate,
  clear,
  memoize,
  ttlFor,
  getCacheFile,
  stats,
};
