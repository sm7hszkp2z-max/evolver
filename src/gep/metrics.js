// ---------------------------------------------------------------------------
// metrics -- append-only task metrics for external_task runs.
//
// Adapted from the Hub asset matched in cycle #0092 ("add task execution
// metrics, record duration_ms, status and retry_count for every
// external_task"). The asset id is deliberately NOT written here: this file
// must not look like a landing of that asset, or the StagnationGuard would
// report the asset as "already present" instead of "landed by this cycle".
//
// Before this module the retry layer only printed one "[Retry] ..." line per
// retry and kept no aggregate record, so a cycle could not tell how long its
// Hub calls took or how many of them had to be retried.
//
// One JSON object per line in <evolution dir>/task_metrics.jsonl. Append-only:
// a crashed writer can lose at most the last line, never the file.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 200;

function metricsDir() {
  try {
    const { getEvolutionDir } = require('./paths');
    return getEvolutionDir();
  } catch (_) {
    return path.join(__dirname, '..', '..', 'logs');
  }
}

function metricsPath() {
  return path.join(metricsDir(), 'task_metrics.jsonl');
}

/**
 * Append one metric record. Never throws: a metrics write must not break an
 * evolution cycle.
 *
 * @param {{label: string, duration_ms: number, status: string|number|null,
 *          retry_count: number, ok?: boolean, error?: string,
 *          task_id?: string|null}} record
 * @returns {boolean} true when the record was written
 */
function recordTaskMetric(record) {
  try {
    if (!record || typeof record !== 'object') return false;
    const dir = metricsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(Object.assign({
      at: new Date().toISOString()
    }, record)) + '\n';
    fs.appendFileSync(metricsPath(), line, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Read the last N metric records (oldest first).
 */
function readTaskMetrics(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  try {
    if (!fs.existsSync(metricsPath())) return [];
    const raw = fs.readFileSync(metricsPath(), 'utf8');
    const lines = raw.split('\n').filter(function (l) { return l.trim() !== ''; });
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch (_) {
        // A half-written line from a crashed writer is skipped, not fatal.
      }
    }
    return out.reverse();
  } catch (_) {
    return [];
  }
}

/**
 * Summarize the last N records.
 *
 * @returns {{count: number, ok: number, failed: number, total_retries: number,
 *            avg_duration_ms: number, max_duration_ms: number,
 *            avg_retries: number, by_status: object}}
 */
function summarizeTaskMetrics(limit) {
  const records = readTaskMetrics(limit);
  const byStatus = {};
  let ok = 0;
  let failed = 0;
  let totalRetries = 0;
  let totalDuration = 0;
  let maxDuration = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i] || {};
    const status = r.status === undefined || r.status === null ? 'unknown' : String(r.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const retries = Number.isFinite(Number(r.retry_count)) ? Number(r.retry_count) : 0;
    totalRetries += retries;
    const dur = Number.isFinite(Number(r.duration_ms)) ? Number(r.duration_ms) : 0;
    totalDuration += dur;
    if (dur > maxDuration) maxDuration = dur;
    if (r.ok === true) ok += 1;
    else if (r.ok === false) failed += 1;
  }

  const count = records.length;
  return {
    count: count,
    ok: ok,
    failed: failed,
    total_retries: totalRetries,
    avg_duration_ms: count > 0 ? Math.round(totalDuration / count) : 0,
    max_duration_ms: maxDuration,
    avg_retries: count > 0 ? Math.round((totalRetries / count) * 100) / 100 : 0,
    by_status: byStatus
  };
}

module.exports = {
  recordTaskMetric,
  readTaskMetrics,
  summarizeTaskMetrics,
  metricsPath,
  DEFAULT_LIMIT
};
