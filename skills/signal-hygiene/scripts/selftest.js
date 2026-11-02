#!/usr/bin/env node
// Self-test for the signal-hygiene skill.
// Run: node skills/signal-hygiene/scripts/selftest.js
// Exits 0 when every rule holds, 1 otherwise.

'use strict';

const assert = require('assert');
const path = require('path');

const hygiene = require(path.join(__dirname, '..', 'index.js'));

const { sanitizeSignals, isKnownSignal, resolveSignal } = hygiene;

// --- exports exist ---------------------------------------------------------
assert.ok(Array.isArray(hygiene.KNOWN_SIGNALS), 'KNOWN_SIGNALS must be an array');
assert.ok(hygiene.KNOWN_SIGNALS.length > 0, 'KNOWN_SIGNALS must not be empty');
assert.ok(Array.isArray(hygiene.PREFIXED_SIGNAL_PREFIXES), 'PREFIXED_SIGNAL_PREFIXES must be an array');
assert.ok(hygiene.ALIAS_MAP && typeof hygiene.ALIAS_MAP === 'object', 'ALIAS_MAP must be an object');
assert.strictEqual(typeof sanitizeSignals, 'function', 'sanitizeSignals must be exported');
assert.strictEqual(typeof isKnownSignal, 'function', 'isKnownSignal must be exported');

// --- every canonical name required by the protocol is present --------------
const REQUIRED = [
  'user_feature_request', 'user_improvement_suggestion', 'perf_bottleneck',
  'capability_gap', 'stable_success_plateau', 'external_opportunity',
  'recurring_error', 'unsupported_input_type', 'evolution_stagnation_detected',
  'repair_loop_detected', 'force_innovation_after_repair_loop', 'log_error',
  'external_task', 'bounty_task', 'memory_missing', 'session_logs_missing',
  'user_missing', 'windows_shell_incompatible', 'empty_cycle_loop_detected',
  'force_steady_state', 'evolution_saturation', 'failure_loop_detected',
  'high_failure_ratio',
];
for (const name of REQUIRED) {
  assert.ok(hygiene.KNOWN_SIGNALS.includes(name), 'KNOWN_SIGNALS must include ' + name);
  assert.strictEqual(isKnownSignal(name), true, name + ' must be a known signal');
}

// --- junk from the Hub task must be dropped --------------------------------
const junk = ['self-wait', '**toolresult**:', 'detected:'];
for (const token of junk) {
  assert.strictEqual(isKnownSignal(token), false, token + ' must not be a known signal');
  assert.strictEqual(resolveSignal(token), null, token + ' must not resolve');
}
assert.deepStrictEqual(
  sanitizeSignals(junk),
  [],
  'junk tokens must be dropped entirely'
);

// --- canonical signals survive ---------------------------------------------
assert.deepStrictEqual(
  sanitizeSignals(['external_task', 'bounty_task']),
  ['external_task', 'bounty_task'],
  'canonical task markers must survive'
);

// --- aliases are rewritten onto canonical signals ---------------------------
assert.deepStrictEqual(
  sanitizeSignals(['performance', 'bottleneck']),
  ['perf_bottleneck'],
  'performance/bottleneck must collapse onto perf_bottleneck'
);
assert.deepStrictEqual(
  sanitizeSignals(['feature']),
  ['user_feature_request'],
  'feature must map onto user_feature_request'
);
assert.deepStrictEqual(
  sanitizeSignals(['capability', 'capability_request']),
  ['capability_gap'],
  'capability must map onto capability_gap'
);
assert.strictEqual(resolveSignal('bottleneck'), 'perf_bottleneck');
assert.strictEqual(resolveSignal('performance'), 'perf_bottleneck');

// --- detail-suffixed families survive verbatim -----------------------------
assert.deepStrictEqual(
  sanitizeSignals(['errsig:boom', 'recurring_errsig(3x):TypeError', 'user_feature_request:add dark mode']),
  ['errsig:boom', 'recurring_errsig(3x):typeerror', 'user_feature_request:add dark mode'],
  'prefixed signal families must be kept'
);
assert.strictEqual(isKnownSignal('errsig:boom'), true);

// --- structural noise is dropped -------------------------------------------
const noise = ['**bold**', '[error]', 'detected:', 'a b', '---', '42', '', '   '];
assert.deepStrictEqual(
  sanitizeSignals(noise),
  [],
  'structurally invalid tokens must be dropped'
);

// --- casing, trimming and de-duplication -----------------------------------
assert.deepStrictEqual(
  sanitizeSignals(['  External_Task  ', 'external_task', 'EXTERNAL_TASK']),
  ['external_task'],
  'tokens must be lowercased, trimmed and de-duplicated in first-seen order'
);

// --- allowUnknown keeps bare unknown tokens but not markup -----------------
assert.deepStrictEqual(
  sanitizeSignals(['self-wait', '**toolresult**:', 'refused'], { allowUnknown: true }),
  ['self-wait', 'refused'],
  'allowUnknown must keep bare unknown tokens only'
);

// --- empty / invalid input is safe -----------------------------------------
assert.deepStrictEqual(sanitizeSignals([]), []);
assert.deepStrictEqual(sanitizeSignals(null), []);
assert.deepStrictEqual(sanitizeSignals(undefined), []);
assert.deepStrictEqual(sanitizeSignals('perf_bottleneck'), ['perf_bottleneck']);

// --- the real regression: a polluted Hub task -------------------------------
const polluted = ['self-wait', '**toolresult**:', 'detected:', 'bottleneck',
                  'performance', 'external_task', 'bounty_task', 'errsig:boom'];
const cleaned = sanitizeSignals(polluted);
assert.deepStrictEqual(
  cleaned,
  ['perf_bottleneck', 'external_task', 'bounty_task', 'errsig:boom'],
  'polluted Hub task must sanitize to canonical signals only'
);
for (const token of cleaned) {
  assert.ok(!token.includes('**'), 'sanitized signal must not carry markdown: ' + token);
  assert.ok(!token.includes(' '), 'sanitized signal must not carry whitespace: ' + token);
}

console.log('[selftest] signal-hygiene: all ' + 'assertions passed');
console.log('[selftest] KNOWN_SIGNALS=' + hygiene.KNOWN_SIGNALS.length +
            ' PREFIXES=' + hygiene.PREFIXED_SIGNAL_PREFIXES.length +
            ' ALIASES=' + Object.keys(hygiene.ALIAS_MAP).length);
process.exit(0);
