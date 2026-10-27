const path = require('path');
const fs = require('fs');
const os = require('os');

function getRepoRoot() {
  if (process.env.EVOLVER_REPO_ROOT) {
    return process.env.EVOLVER_REPO_ROOT;
  }

  let dir = path.resolve(__dirname, '..', '..');
  while (dir !== '/' && dir !== '.') {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return path.resolve(__dirname, '..', '..');
}

// Read the workspace candidates declared in the OpenClaw config.
// Priority: explicit env var > repo-local "workspace/" dir > openclaw.json > repo root.
// The old fallback was path.resolve(__dirname, '..', '..', '..', '..'), which for a
// repo at /home/<user>/<repo> resolves to /home — that is how a stray /home/memory
// state tree came into existence. Never resolve above the home directory.
function getConfiguredWorkspaces() {
  const candidates = [];
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const agents = cfg && cfg.agents ? cfg.agents : null;
      if (agents && agents.defaults && typeof agents.defaults.workspace === 'string') {
        candidates.push(agents.defaults.workspace);
      }
      if (agents && agents.entries && typeof agents.entries === 'object') {
        for (const key of Object.keys(agents.entries)) {
          const e = agents.entries[key];
          if (e && typeof e.workspace === 'string') candidates.push(e.workspace);
        }
      }
    }
  } catch (_) {}
  return candidates;
}

function getWorkspaceRoot() {
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }

  const repoRoot = getRepoRoot();
  const workspaceDir = path.join(repoRoot, 'workspace');
  if (fs.existsSync(workspaceDir)) {
    return workspaceDir;
  }

  for (const c of getConfiguredWorkspaces()) {
    const ws = String(c).trim();
    if (!ws) continue;
    if (fs.existsSync(path.join(ws, 'MEMORY.md')) || fs.existsSync(path.join(ws, 'memory'))) {
      return ws;
    }
  }

  // Fall back to the repo root itself — never to a parent of the home directory.
  return repoRoot;
}

// Resolve the OpenClaw agent workspace that actually owns MEMORY.md / USER.md
// and the daily memory notes. The evolver repo usually lives outside that
// workspace, so a repo-relative guess points at the wrong directory and the
// GEP prompt is filled with "[MEMORY.md MISSING]" / "[USER.md MISSING]".
// Priority: explicit env var > openclaw.json (agents.defaults.workspace) > repo guess.
function getOpenclawWorkspaceRoot() {
  const envWs = String(process.env.OPENCLAW_WORKSPACE || '').trim();
  if (envWs) return envWs;

  for (const c of getConfiguredWorkspaces()) {
    const ws = String(c).trim();
    if (!ws) continue;
    if (fs.existsSync(path.join(ws, 'MEMORY.md')) || fs.existsSync(path.join(ws, 'memory'))) {
      return ws;
    }
  }

  return getWorkspaceRoot();
}

// Memory directory that holds daily notes (YYYY-MM-DD.md) for the OpenClaw
// workspace. Falls back to the evolver memory dir when the workspace has none.
function getOpenclawMemoryDir() {
  const ws = getOpenclawWorkspaceRoot();
  const wsMem = path.join(ws, 'memory');
  try {
    if (fs.existsSync(wsMem)) return wsMem;
  } catch (_) {}
  return getMemoryDir();
}

// Local-time date stamp (YYYY-MM-DD) for daily memory notes.
// toISOString() returns UTC, so between 00:00 and 08:00 local time it yields
// the previous day and the evolver looks for a daily note that does not exist.
function localDateStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLogsDir() {
  return process.env.EVOLVER_LOGS_DIR || path.join(getWorkspaceRoot(), 'logs');
}

function getEvolverLogPath() {
  return path.join(getLogsDir(), 'evolver_loop.log');
}

function getMemoryDir() {
  return process.env.MEMORY_DIR || path.join(getWorkspaceRoot(), 'memory');
}

// --- Session Scope Isolation ---
// When EVOLVER_SESSION_SCOPE is set (e.g., to a Discord channel ID or project name),
// evolution state, memory graph, and assets are isolated to a per-scope subdirectory.
// This prevents cross-channel/cross-project memory contamination.
// When NOT set, everything works as before (global scope, backward compatible).
function getSessionScope() {
  const raw = String(process.env.EVOLVER_SESSION_SCOPE || '').trim();
  if (!raw) return null;
  // Sanitize: only allow alphanumeric, dash, underscore, dot (prevent path traversal).
  const safe = raw.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 128);
  if (!safe || /^\.{1,2}$/.test(safe) || /\.\./.test(safe)) return null;
  return safe;
}

function getEvolutionDir() {
  const baseDir = process.env.EVOLUTION_DIR || path.join(getMemoryDir(), 'evolution');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getGepAssetsDir() {
  const repoRoot = getRepoRoot();
  const baseDir = process.env.GEP_ASSETS_DIR || path.join(repoRoot, 'assets', 'gep');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getSkillsDir() {
  return process.env.SKILLS_DIR || path.join(getWorkspaceRoot(), 'skills');
}

function getNarrativePath() {
  return path.join(getEvolutionDir(), 'evolution_narrative.md');
}

function getEvolutionPrinciplesPath() {
  const repoRoot = getRepoRoot();
  const custom = path.join(repoRoot, 'EVOLUTION_PRINCIPLES.md');
  if (fs.existsSync(custom)) return custom;
  return path.join(repoRoot, 'assets', 'gep', 'EVOLUTION_PRINCIPLES.md');
}

function getReflectionLogPath() {
  return path.join(getEvolutionDir(), 'reflection_log.jsonl');
}

module.exports = {
  getRepoRoot,
  getWorkspaceRoot,
  getOpenclawWorkspaceRoot,
  getOpenclawMemoryDir,
  localDateStamp,
  getLogsDir,
  getEvolverLogPath,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
  getSkillsDir,
  getSessionScope,
  getNarrativePath,
  getEvolutionPrinciplesPath,
  getReflectionLogPath,
};

