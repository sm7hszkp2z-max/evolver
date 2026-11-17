// ---------------------------------------------------------------------------
// stagnationGuard -- turn the plateau / redundancy signals into a verdict.
//
// Adapted from the Hub asset matched in cycle #0092:
//   sha256:e8b9eca2159a6bb09354917e6484f8999bad4e52179560bb7d8dd97d8e6734d5
//   ("hashRef": AbortController hard timeout + zod validation middleware +
//    exponential backoff retry + a stable_success_plateau detector that
//    freezes stalled evolution loops + task metrics).
//
// Deliberately NOT copied from that asset:
//   * its zod validation middleware -- this repo hosts no inbound HTTP server
//     and zod is not a dependency (no new npm dependency is allowed here).
//   * its own AbortController + exponential backoff layer -- src/gep/retry.js
//     already owns the per-attempt timeout and the backoff for every Hub
//     call; a second retry layer would be a duplicate, not an improvement.
//
// What IS landed here (the two parts the asset has and this repo does not):
//   1. detectPlateau(history)      -> stable_success_plateau detection over the
//      real per-cycle evolution history (assets/gep/events.jsonl).
//   2. detectRedundantAsset(assetId) -> "the matched Hub asset is already in
//      the tree": rewriting a byte-identical file is an empty cycle (the
//      operator hit exactly this on cycle #0091).
//   3. guard(history, assetId)    -> the combined verdict the runner records.
//
// Every function in this module is pure and dependency-free: no network, no
// writes, no state. Reading files is allowed and required by the redundant
// asset scan.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DEFAULT_WINDOW = 20;
const DEFAULT_MIN_CYCLES = 5;
const DEFAULT_VARIANCE_THRESHOLD = 0.01;
const DEFAULT_MAX_SCAN_FILES = 4000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.cache', '.pytest_cache', 'logs', 'cache']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.mp3', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf', '.eot', '.so', '.dll', '.exe', '.bin', '.pyc', '.sqlite', '.db']);

// --- success metric --------------------------------------------------------
//
// The plateau rule needs one number per cycle. The metric chosen here is the
// per-cycle outcome.score that every EvolutionEvent already carries
// (assets/gep/events.jsonl -> outcome.score, 0..1).
//
// Why outcome.score and not something else:
//   * blast_radius.lines measures how big the change was, not how good it was
//     -- a plateau of 5 huge-but-identical cycles would look "varied".
//   * a normalized line-count metric would measure the same thing.
//   * outcome.score is written by solidify on every cycle, success or fail,
//     so it is the only metric that exists for the full history window and
//     it is directly comparable across cycles (same 0..1 scale).
// The variance threshold (< 0.01) therefore means: the cycles are not just
// succeeding, they are succeeding by the exact same amount.

function isEvolutionEvent(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'EvolutionEvent') return true;
  return !!entry.outcome && typeof entry.outcome === 'object';
}

function readOutcome(entry) {
  const outcome = entry && entry.outcome && typeof entry.outcome === 'object' ? entry.outcome : null;
  const status = outcome && typeof outcome.status === 'string' ? outcome.status.toLowerCase() : null;
  const raw = outcome ? Number(outcome.score) : NaN;
  const score = Number.isFinite(raw) ? raw : null;
  return {
    status: status,
    score: score,
    success: status === 'success'
  };
}

function varianceOf(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const mean = values.reduce(function (acc, v) { return acc + v; }, 0) / values.length;
  return values.reduce(function (acc, v) { return acc + (v - mean) * (v - mean); }, 0) / values.length;
}

/**
 * Detect a stable-success plateau in the evolution history.
 *
 * Rule (adapted from the Hub asset): over the last N cycles (default 20), if
 * there are at least 5 cycles, EVERY cycle succeeded (no failed / rolled-back
 * solidify) and the variance of the per-cycle success metric (outcome.score)
 * is below 0.01, the system sits in a stable-success plateau.
 *
 * @param {Array} history  EvolutionEvent objects (oldest first).
 * @param {object} [opts]  { window, minCycles, varianceThreshold }
 * @returns {{stalled: boolean, reason: string, consecutiveStalled: number, variance: number, window: number}}
 */
function detectPlateau(history, opts) {
  const o = opts || {};
  const windowSize = Number.isFinite(o.window) && o.window > 0 ? Math.floor(o.window) : DEFAULT_WINDOW;
  const minCycles = Number.isFinite(o.minCycles) && o.minCycles > 0 ? Math.floor(o.minCycles) : DEFAULT_MIN_CYCLES;
  const threshold = Number.isFinite(o.varianceThreshold) ? o.varianceThreshold : DEFAULT_VARIANCE_THRESHOLD;

  const events = (Array.isArray(history) ? history : []).filter(isEvolutionEvent);
  const win = events.slice(-windowSize);

  const result = {
    stalled: false,
    reason: 'no_history',
    consecutiveStalled: 0,
    variance: 0,
    window: win.length
  };
  if (win.length === 0) return result;

  // How many successful cycles sit at the tail of the window.
  let consecutive = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    if (!readOutcome(win[i]).success) break;
    consecutive += 1;
  }
  result.consecutiveStalled = consecutive;

  if (win.length < minCycles) {
    result.reason = 'not_enough_cycles';
    return result;
  }
  if (consecutive < win.length) {
    // At least one cycle in the window failed -> not a stable success plateau.
    result.reason = 'recent_failure';
    return result;
  }

  const scores = [];
  for (let i = 0; i < win.length; i++) {
    const score = readOutcome(win[i]).score;
    if (score !== null) scores.push(score);
  }
  if (scores.length < minCycles) {
    result.reason = 'no_score_metric';
    return result;
  }

  result.variance = varianceOf(scores);
  if (result.variance >= threshold) {
    result.reason = 'variance_above_threshold';
    return result;
  }

  result.stalled = true;
  result.reason = 'stable_success_plateau';
  return result;
}

function defaultRoot() {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Scan the repo tree for a Hub asset id.
 *
 * True when the matched asset id already appears in the tree: landing it
 * again would rewrite a byte-identical file, i.e. an empty cycle.
 *
 * @param {string} assetId  e.g. "sha256:e8b9eca2..."
 * @param {object} [opts]   { root, maxFiles, maxFileBytes, ignore }
 * @returns {{redundant: boolean, reason: string, paths: string[]}}
 */
function detectRedundantAsset(assetId, opts) {
  const o = opts || {};
  const id = assetId === undefined || assetId === null ? '' : String(assetId).trim();
  const out = { redundant: false, reason: 'no_asset_id', paths: [] };
  if (!id) return out;

  const root = o.root ? path.resolve(String(o.root)) : defaultRoot();
  if (!fs.existsSync(root)) {
    out.reason = 'root_not_found';
    return out;
  }

  const maxFiles = Number.isFinite(o.maxFiles) && o.maxFiles > 0 ? Math.floor(o.maxFiles) : DEFAULT_MAX_SCAN_FILES;
  const maxFileBytes = Number.isFinite(o.maxFileBytes) && o.maxFileBytes > 0 ? Math.floor(o.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  // The guard's own source and its test carry the asset id as documentation /
  // test fixture. A mention is not a landing, so they never count as "the asset
  // is already in the tree".
  const defaultIgnore = [
    __filename,
    path.resolve(__dirname, '..', '..', 'test', 'stagnationGuard.test.js')
  ];
  const ignore = defaultIgnore.concat(
    Array.isArray(o.ignore) ? o.ignore.map(function (p) { return path.resolve(String(p)); }) : []
  );

  // Match the full "sha256:<hex>" form and the bare hex form, so a file that
  // only carries the digest still counts as "already landed".
  const needles = [id];
  const bare = id.replace(/^sha256:/i, '');
  if (bare && bare !== id) needles.push(bare);

  const hits = [];
  let scanned = 0;
  let truncated = false;

  function walk(dir) {
    if (scanned >= maxFiles || truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      if (scanned >= maxFiles) { truncated = true; return; }
      const entry = entries[i];
      const full = path.join(dir, entry.name);
      if (ignore.indexOf(full) !== -1) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.size === 0) continue;
      if (stat.size > maxFileBytes) continue;
      if (SKIP_EXT.has(path.extname(full).toLowerCase())) continue;
      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (_) {
        continue;
      }
      // A NUL byte means the file is binary -> do not substring match it.
      if (content.indexOf('\u0000') !== -1) continue;
      scanned += 1;
      for (let n = 0; n < needles.length; n++) {
        if (content.indexOf(needles[n]) !== -1) {
          if (hits.indexOf(full) === -1) hits.push(full);
          break;
        }
      }
    }
  }

  walk(root);

  if (hits.length > 0) {
    out.redundant = true;
    out.reason = 'asset_already_present';
    out.paths = hits;
    return out;
  }

  out.reason = truncated ? 'asset_not_found_scan_truncated' : 'asset_not_found';
  return out;
}

/**
 * Combined verdict used by the runner.
 *
 * @returns {{verdict: string, stalled: boolean, redundant: boolean, reason: string,
 *            asset_id: string|null, plateau: object, asset: object}}
 */
function guard(history, assetId, opts) {
  const o = opts || {};
  const plateau = detectPlateau(history, o);
  const asset = detectRedundantAsset(assetId, o);
  let verdict = 'ok';
  let reason = plateau.reason;
  if (asset.redundant) {
    verdict = 'redundant-asset';
    reason = asset.reason;
  } else if (plateau.stalled) {
    verdict = 'stalled';
    reason = plateau.reason;
  }
  return {
    verdict: verdict,
    stalled: plateau.stalled,
    redundant: asset.redundant,
    reason: reason,
    asset_id: assetId ? String(assetId) : null,
    plateau: plateau,
    asset: asset
  };
}

// One clear, greppable line. The runner prints exactly this.
function formatVerdict(v) {
  if (!v) return '[StagnationGuard] verdict=ok reason=unknown';
  const parts = ['[StagnationGuard] verdict=' + v.verdict, 'reason=' + v.reason];
  if (v.asset_id) parts.push('asset=' + v.asset_id);
  if (v.plateau) {
    parts.push('window=' + v.plateau.window);
    parts.push('consecutive=' + v.plateau.consecutiveStalled);
    parts.push('variance=' + Number(v.plateau.variance || 0).toFixed(6));
  }
  if (v.asset && v.asset.paths && v.asset.paths.length) {
    parts.push('paths=' + v.asset.paths.join(','));
  }
  return parts.join(' ');
}

module.exports = {
  detectPlateau,
  detectRedundantAsset,
  guard,
  formatVerdict,
  varianceOf,
  DEFAULT_WINDOW,
  DEFAULT_MIN_CYCLES,
  DEFAULT_VARIANCE_THRESHOLD
};
