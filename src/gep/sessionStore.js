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

// Read recent transcript message lines from the SQLite session store.
// Returns an array of raw JSONL lines (one JSON object per entry).
function readRecentSessionLines(opts = {}) {
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) ? Number(opts.maxBytes) : 120000;
  const sessionsPerDb = Number.isFinite(Number(opts.sessionsPerDb)) ? Number(opts.sessionsPerDb) : 3;
  const rowsPerSession = Number.isFinite(Number(opts.rowsPerSession)) ? Number(opts.rowsPerSession) : 200;
  const scope = opts.scope ? String(opts.scope).toLowerCase() : null;
  const skipSessionKeys = Array.isArray(opts.skipSessionKeys) ? opts.skipSessionKeys : [];

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
        if (skipSessionKeys.some((k) => key.includes(k))) continue;
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
};
