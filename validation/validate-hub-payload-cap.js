#!/usr/bin/env node
// Cycle #0099 validation: the rendered Hub payload must stay valid JSON and
// within the hub_payload_max_chars budget declared in the guardrails config
// (the single source of truth for guardrail values).
'use strict';

const fs = require('fs');
const path = require('path');

const GUARDRAILS_REL = '.evolver/gep/tool_usage_guardrails.json';

function fail(msg) {
  console.error('[FAIL] validate-hub-payload-cap: ' + msg);
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const guardrailsPath = path.join(repoRoot, GUARDRAILS_REL);
if (!fs.existsSync(guardrailsPath)) fail('missing guardrails config: ' + GUARDRAILS_REL);
let guardrails;
try {
  guardrails = JSON.parse(fs.readFileSync(guardrailsPath, 'utf8'));
} catch (err) {
  fail('guardrails config is not valid JSON: ' + err.message);
}
const limit = Number(guardrails.hub_payload_max_chars);
if (!Number.isInteger(limit) || limit <= 0) fail('hub_payload_max_chars must be a positive integer in ' + GUARDRAILS_REL);

const { buildHubMatchedBlock } = require(path.join(repoRoot, 'src/gep/prompt.js'));

const strategy = [
  'Analyze tool usage patterns and find the root cause of repetition',
  'Enforce exec limits and route ad-hoc script execution to registered tools',
  'Batch operations into single commands and deduplicate signals'
];
const payload = {
  id: 'capsule_validation_oversized',
  gene: 'gene_gep_optimize_tool_usage',
  type: 'Capsule',
  asset_id: 'sha256:validation-oversized',
  summary: 'Oversized payload used by the hub payload cap validation',
  strategy,
  anti_patterns: ['repeated exec calls'],
  outcome: { status: 'success', score: 0.73 },
  trigger: ['repeated_tool_usage:exec'],
  content: 'Gene: gene_gep_optimize_tool_usage\n\n...[TRUNCATED]...\n' + 'x'.repeat(60000),
  env_fingerprint: { cwd: 'y'.repeat(4000) }
};

const block = buildHubMatchedBlock({
  capsule: { payload, asset_id: payload.asset_id, confidence: 0.73 }
});
const match = block.match(/```json\n([\s\S]*?)\n```/);
if (!match) fail('hub block does not embed a fenced json payload');
const json = match[1];
if (json.length > limit) fail('rendered hub payload is ' + json.length + ' chars, over the limit of ' + limit);
let parsed;
try {
  parsed = JSON.parse(json);
} catch (err) {
  fail('rendered hub payload is not valid JSON: ' + err.message);
}
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('rendered hub payload must be a JSON object');
if (block.includes('[TRUNCATED]')) fail('embedded truncation marker survived into the hub block');
for (const step of strategy) {
  if (!block.includes(step)) fail('hub strategy step missing from the block: ' + step);
}
console.log('[OK] hub payload is valid JSON, ' + json.length + ' chars (limit ' + limit + '), strategy preserved.');
console.log('[SUCCESS] validate-hub-payload-cap: the hub payload stays bounded and valid.');
