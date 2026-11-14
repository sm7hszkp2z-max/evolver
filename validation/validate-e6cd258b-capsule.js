#!/usr/bin/env node
// Replayable validation for Hub asset sha256:e6cd258b (gene_gep_optimize_tool_usage).
// 1) Runs the exact Hub target-specific assertion (must exit 0).
// 2) Checks the guardrails config landed and parses as JSON.
// Exits non-zero on any failure.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ASSET_ID = 'sha256:e6cd258ba12815671026b558253c9078fa87c8db680ef3bf613405477f4ac96f';
const GUARDRAILS_REL = '.evolver/gep/tool_usage_guardrails.json';

// Exact Hub target-specific assertion source.
const HUB_ASSERTION = 'if (["guardrail","tool","trace"].join(":") !== "guardrail:tool:trace") process.exit(1)';

function fail(msg) {
  console.error('[FAIL] validate-e6cd258b-capsule: ' + msg);
  process.exit(1);
}

// 1) Hub target-specific assertion.
try {
  execFileSync(process.execPath, ['-e', HUB_ASSERTION], { stdio: 'pipe' });
} catch (err) {
  fail('Hub target-specific assertion did not exit 0: ' + (err && err.message));
}
console.log('[OK] Hub target-specific assertion executed locally with exit 0.');

// 2) Guardrails config must exist and parse as JSON.
const guardrailsPath = path.resolve(__dirname, '..', GUARDRAILS_REL);
if (!fs.existsSync(guardrailsPath)) {
  fail('missing guardrails config: ' + GUARDRAILS_REL);
}
let guardrails;
try {
  guardrails = JSON.parse(fs.readFileSync(guardrailsPath, 'utf8'));
} catch (err) {
  fail('guardrails config is not valid JSON: ' + err.message);
}
if (!guardrails || typeof guardrails !== 'object' || Array.isArray(guardrails)) {
  fail('guardrails config must be a JSON object');
}
if (guardrails.asset_id !== ASSET_ID) {
  fail('guardrails asset_id mismatch: ' + guardrails.asset_id);
}
console.log('[OK] guardrails config exists and parses as JSON: ' + GUARDRAILS_REL);

console.log('[SUCCESS] validate-e6cd258b-capsule: asset ' + ASSET_ID + ' verified.');
