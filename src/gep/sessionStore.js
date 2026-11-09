// Session transcript fallback reader.
//
// Why this exists:
// OpenClaw moved active session transcripts out of flat JSONL files and into a
// per-agent SQLite store (`~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`,
// table `transcript_events`). The flat `sessions/*.jsonl` files are archived and
// removed, so the evolver's JSONL-only reader reports "[NO JSONL FILES]" and the
// GEP pipeline emits a permanent `session_logs_missing` signal with no context.
//
// This module provides a read-only fallback that reconstructs recent transcript
// lines from the SQLite store. It never writes to the database.
//
// Safety: read-only connection, best-effort, every failure degrades to [].

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getRepoRoot } = require('./paths');

const AGENTS_ROOT = path.join(os.homedir(), '.openclaw', 'agents');

function listAgentDbPaths() {
  try {
    return fs
      .readdirSync(AGENTS_ROOT)
      .map((name) => path.join(AGENTS_ROOT, name, 'agent', 'openclaw-agent.sqlite'))
      .filter((p) => {
        try {
          const st = fs.statSync(p);
          return st.isFile() && st.size > 0;
        } catch (_) {
          return false;
        }
      });
  } catch (_) {
    return [];
  }
}

function decodeEvent(row) {
  if (row && typeof row.event_json === 'string' && row.event_json) return row.event_json;
  if (row && row.event_zstd) {
    try {
      const zlib = require('node:zlib');
      if (typeof zlib.zstdDecompressSync === 'function') {
        return zlib.zstdDecompressSync(row.event_zstd).toString('utf8');
      }
    } catch (_) {
      /* unsupported compression or corrupt row -> skip */
    }
  }
  return null;
}

// --- Own-traffic exclusion -------------------------------------------------
// The evolver must never measure its own orchestration traffic.
//
// Two session families belong to the evolver itself:
//   1. the cron session that runs the GEP bridge
//      (agent:<agent>:cron:<jobId>:run:<runId>)
//   2. the "Hand" sub-agent session the bridge spawns to execute the cycle
//      (agent:<agent>:subagent:<uuid>)
//
// Both are resolved dynamically, never hard-coded, so a recreated cron job
// keeps working:
//   * the cron job id comes from the OpenClaw cron store, matched by the
//     command the job runs ("... index.js run" inside the evolver repo)
//   * the Hand session ids come from the swarm run table, matched by their
//     controller / requester session (the evolver cron session)
// Every lookup is best-effort: when the store cannot be read the skip list
// falls back to the static 'evolver_hand_' marker.
let ownMarkerCache = null;

function openGatewayStateDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(os.homedir(), '.openclaw', 'state', 'openclaw.sqlite');
    if (!fs.existsSync(dbPath)) return null;
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (_) {
    return null;
  }
}

// Cron job ids of the jobs that run THIS evolver.
function resolveOwnCronJobIds() {
  const ids = [];
  let repoRoot = '';
  try { repoRoot = String(getRepoRoot() || ''); } catch (_) { repoRoot = ''; }
  let db = null;
  try {
    db = openGatewayStateDb();
    if (db) {
      let rows = [];
      try {
        rows = db.prepare('SELECT job_id, name, job_json FROM cron_jobs').all();
      } catch (_) {
        rows = [];
      }
      for (const row of rows) {
        const jobId = String(row.job_id || '');
        const name = String(row.name || '');
        const blob = String(row.job_json || '');
        if (!jobId || !blob) continue;
        const runsEvolver = /index\.js\s+run/.test(blob) && (blob.includes(repoRoot) || /evolver/i.test(name));
        if (runsEvolver) ids.push(jobId);
      }
    }
  } catch (_) {
    /* best effort */
  } finally {
    try { if (db && typeof db.close === 'function') db.close(); } catch (_) {}
  }
  return ids;
}

// Session keys of the sub-agents the evolver spawned (the "Hand" sessions).
function resolveOwnChildSessionKeys(cronJobIds) {
  const keys = [];
  if (!cronJobIds.length) return keys;
  let db = null;
  try {
    db = openGatewayStateDb();
    if (db) {
      let rows = [];
      try {
        rows = db
          .prepare('SELECT child_session_key, controller_session_key, requester_session_key FROM subagent_runs ORDER BY created_at DESC LIMIT 500')
          .all();
      } catch (_) {
        rows = [];
      }
      for (const row of rows) {
        const controller = String(row.controller_session_key || '');
        const requester = String(row.requester_session_key || '');
        const owned = cronJobIds.some((id) => controller.includes(id) || requester.includes(id));
        if (owned && row.child_session_key) keys.push(String(row.child_session_key));
      }
    }
  } catch (_) {
    /* best effort */
  } finally {
    try { if (db && typeof db.close === 'function') db.close(); } catch (_) {}
  }
  return keys;
}

// Markers of the evolver's own sessions. A session key containing one of them
// is the evolver measuring itself, so it is skipped.
function getEvolverOwnSessionMarkers() {
  if (ownMarkerCache) return ownMarkerCache;
  const markers = ['evolver_hand_'];
  try {
    const cronJobIds = resolveOwnCronJobIds();
    for (const id of cronJobIds) markers.push('cron:' + id);
    for (const key of resolveOwnChildSessionKeys(cronJobIds)) markers.push(key);
  } catch (_) {
    /* best effort: keep the static marker */
  }
  ownMarkerCache = markers;
  return markers;
}

// Read recent transcript message lines from the SQLite session store.
// Returns an array of raw JSONL lines (one JSON object per entry).
function readRecentSessionLines(opts = {}) {
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) ? Number(opts.maxBytes) : 120000;
  const sessionsPerDb = Number.isFinite(Number(opts.sessionsPerDb)) ? Number(opts.sessionsPerDb) : 3;
  const rowsPerSession = Number.isFinite(Number(opts.rowsPerSession)) ? Number(opts.rowsPerSession) : 200;
  const scope = opts.scope ? String(opts.scope).toLowerCase() : null;
  const skipSessionKeys = Array.isArray(opts.skipSessionKeys) ? opts.skipSessionKeys : [];
  // Always exclude the evolver's own sessions: the GEP cron session and
  // the Hand session it spawns are orchestration traffic, not agent
  // behaviour. Measuring them made the evolver count its own tool calls
  // as agent behaviour, which pinned the signal set cycle after cycle.
  const effectiveSkipKeys = Array.from(new Set(skipSessionKeys.concat(getEvolverOwnSessionMarkers())));

  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {
    return []; // node:sqlite unavailable (older Node) -> no fallback available
  }
  if (!DatabaseSync) return [];

  const collected = [];
  for (const dbPath of listAgentDbPaths()) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (_) {
      continue;
    }
    try {
      let sessions = [];
      try {
        sessions = db
          .prepare(
            'SELECT session_id, session_key, transcript_updated_at FROM session_windows ' +
              'WHERE transcript_updated_at IS NOT NULL ORDER BY transcript_updated_at DESC LIMIT ?'
          )
          .all(sessionsPerDb);
      } catch (_) {
        sessions = [];
      }
      for (const s of sessions) {
        const key = String(s.session_key || '');
        if (effectiveSkipKeys.some((k) => key.includes(k))) continue;
        if (scope && key && !key.toLowerCase().includes(scope)) continue;
        let rows = [];
        try {
          rows = db
            .prepare('SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
            .all(s.session_id, rowsPerSession);
        } catch (_) {
          rows = [];
        }
        for (let i = rows.length - 1; i >= 0; i--) {
          const line = decodeEvent(rows[i]);
          if (!line) continue;
          if (line.indexOf('"type":"message"') === -1) continue;
          collected.push({ ts: Number(s.transcript_updated_at) || 0, line });
        }
      }
    } catch (_) {
      /* ignore db-level failures and continue with the next agent */
    } finally {
      try {
        if (db && typeof db.close === 'function') db.close();
      } catch (_) {}
    }
  }

  // Newest first, then trim to the byte budget.
  collected.sort((a, b) => b.ts - a.ts);
  const out = [];
  let bytes = 0;
  for (const item of collected) {
    const size = item.line.length;
    if (bytes + size > maxBytes) break;
    out.push(item.line);
    bytes += size;
  }
  return out;
}

module.exports = {
  readRecentSessionLines,
  listAgentDbPaths,
  getEvolverOwnSessionMarkers,
};
