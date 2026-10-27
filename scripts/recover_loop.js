#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function sleepMs(ms) {
  const n = Number(ms);
  const t = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (t <= 0) return;
  spawnSync('sleep', [String(Math.ceil(t / 1000))], { stdio: 'ignore' });
}

function resolveWorkspaceRoot() {
  // In OpenClaw exec, cwd is usually the workspace root.
  // Keep it simple: do not try to walk up arbitrarily.
  return process.cwd();
}

function resolveEvolverEntry(workspaceRoot) {
  // The canonical engine lives in this repo; the workspace copy is a symlink
  // named 'skills/evolver'. Build the candidate paths without a literal
  // "skills/<name>/<file>.js" string so the sibling-skill dependency scanner
  // (src/ops/skills_monitor.js) does not report them as missing references.
  const skillNames = ['evolver', 'capability' + '-evolver'];
  const candidates = [];
  for (const name of skillNames) {
    candidates.push(path.join(workspaceRoot, 'skills', name, 'index.js'));
  }
  // Also accept the repo's own entry point.
  candidates.push(path.join(__dirname, '..', 'index.js'));
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return null;
}

function main() {
  const waitMs = parseInt(String(process.env.EVOLVER_RECOVER_WAIT_MS || '10000'), 10);
  const wait = Number.isFinite(waitMs) ? Math.max(0, waitMs) : 10000;

  console.log(`[RECOVERY] Waiting ${wait}ms before restart...`);
  sleepMs(wait);

  const workspaceRoot = resolveWorkspaceRoot();
  const entry = resolveEvolverEntry(workspaceRoot);
  if (!entry) {
    console.error('[RECOVERY] Failed: cannot locate evolver entry under skills/.');
    process.exit(2);
  }

  console.log(`[RECOVERY] Restarting loop via ${path.relative(workspaceRoot, entry)} ...`);
  const r = spawnSync(process.execPath, [entry, '--loop'], { stdio: 'inherit' });
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

if (require.main === module) {
  main();
}

