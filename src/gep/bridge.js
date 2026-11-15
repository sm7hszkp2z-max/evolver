const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function nowIso() {
  return new Date().toISOString();
}

function clip(text, maxChars) {
  const s = String(text || '');
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return s;
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 40)) + '\n...[TRUNCATED]...\n';
}

function writePromptArtifact({ memoryDir, cycleId, runId, prompt, meta }) {
  const dir = String(memoryDir || '').trim();
  if (!dir) throw new Error('bridge: missing memoryDir');
  ensureDir(dir);
  const safeCycle = String(cycleId || 'cycle').replace(/[^a-zA-Z0-9_\-#]/g, '_');
  const safeRun = String(runId || Date.now()).replace(/[^a-zA-Z0-9_\-]/g, '_');
  const base = `gep_prompt_${safeCycle}_${safeRun}`;
  const promptPath = path.join(dir, base + '.txt');
  const metaPath = path.join(dir, base + '.json');

  fs.writeFileSync(promptPath, String(prompt || ''), 'utf8');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        type: 'GepPromptArtifact',
        at: nowIso(),
        cycle_id: cycleId || null,
        run_id: runId || null,
        prompt_path: promptPath,
        meta: meta && typeof meta === 'object' ? meta : null,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  return { promptPath, metaPath };
}

function normalizeAgentIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// Pick the agent id that OpenClaw will actually accept for sessions_spawn.
// - no allowlist  -> keep the requested id (backward compatible)
// - id allowed    -> keep it
// - not allowed   -> fall back to the first allowed id
function resolveBridgeAgentId({ requested, allowed } = {}) {
  const req = String(requested || '').trim() || 'main';
  const list = normalizeAgentIds(allowed);
  if (!list.length) return req;
  if (list.includes(req)) return req;
  return list[0];
}

// Allowlist of agent ids accepted by the local OpenClaw deployment.
// Sources: EVOLVER_BRIDGE_AGENT_IDS env (comma separated) and
// .evolver/gep/bridge.json ({"allowedAgentIds":["personal"]}).
// Missing file / missing env -> empty allowlist (backward compatible).
function loadBridgeAgentAllowlist({ env, repoRoot } = {}) {
  const e = env || process.env || {};
  const ids = [];
  const fromEnv = String(e.EVOLVER_BRIDGE_AGENT_IDS || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  ids.push(...fromEnv);
  const root = String(repoRoot || process.cwd() || '');
  try {
    if (root) {
      const cfgPath = path.join(root, '.evolver', 'gep', 'bridge.json');
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        ids.push(...normalizeAgentIds(raw && raw.allowedAgentIds));
      }
    }
  } catch (e) {}
  return normalizeAgentIds(ids);
}

function renderSessionsSpawnCall({ task, agentId, label, cleanup, allowedAgentIds } = {}) {
  const t = String(task || '').trim();
  if (!t) throw new Error('bridge: missing task');
  const a = resolveBridgeAgentId({ requested: agentId || 'main', allowed: allowedAgentIds });
  const l = String(label || 'gep_bridge');
  const c = cleanup ? String(cleanup) : 'delete';

  // Output valid JSON so wrappers can parse with JSON.parse (not regex).
  // The wrapper uses lastIndexOf('sessions_spawn(') + JSON.parse to extract the task.
  const payload = JSON.stringify({ task: t, agentId: a, cleanup: c, label: l });
  return `sessions_spawn(${payload})`;
}

module.exports = {
  clip,
  writePromptArtifact,
  renderSessionsSpawnCall,
  resolveBridgeAgentId,
  loadBridgeAgentAllowlist,
};

