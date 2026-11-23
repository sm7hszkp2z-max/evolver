// ---------------------------------------------------------------------------
// signal-hygiene -- decide which tokens are real evolution signals.
//
// Why this module exists
// -----------------------
// Hub tasks arrive with a free-form `signals` string and a free-form `title`.
// src/gep/taskReceiver.js used to copy those fragments verbatim into the
// evolution cycle, so prose and tool-output wrappers ("self-wait",
// "**toolresult**:", "detected:") became first-class signals:
//   * no gene declares signals_match for them, so they never matched a gene;
//   * they survived the de-duplication filter in src/gep/signals.js, which only
//     suppresses a signal seen 3+ times in the last 8 events;
//   * they kept the stagnation / plateau detectors firing, which forced the
//     cycle into yet another INNOVATE round with no real work to do;
//   * they were printed into the GEP prompt as if they were requirements.
//
// This module is the single place that decides what a signal is. It is
// dependency-free, side-effect free and never touches the network, so it is
// safe to require from src/gep/taskReceiver.js.
// ---------------------------------------------------------------------------

'use strict';

// ---------------------------------------------------------------------------
// Canonical signal names.
//
// Every name below already exists in this repository. Provenance:
//   src/gep/signals.js      OPPORTUNITY_SIGNALS plus the defensive, opportunity
//                            and loop-detector signals extractSignals() pushes.
//   src/gep/mutation.js     OPPORTUNITY_SIGNALS plus the hasErrorishSignal()
//                            guard names.
//   src/gep/taskReceiver.js external_task / bounty_task.
// ---------------------------------------------------------------------------
var KNOWN_SIGNALS = [
  // -- src/gep/signals.js: OPPORTUNITY_SIGNALS -----------------------------
  'user_feature_request',
  'user_improvement_suggestion',
  'perf_bottleneck',
  'capability_gap',
  'stable_success_plateau',
  'external_opportunity',
  'recurring_error',
  'unsupported_input_type',
  'evolution_stagnation_detected',
  'repair_loop_detected',
  'force_innovation_after_repair_loop',

  // -- src/gep/signals.js: defensive / resource signals ---------------------
  'log_error',
  'memory_missing',
  'user_missing',
  'integration_key_missing',
  'session_logs_missing',
  'windows_shell_incompatible',
  'path_outside_workspace',
  'protocol_drift',

  // -- src/gep/signals.js: loop / saturation detectors ----------------------
  'empty_cycle_loop_detected',
  'force_steady_state',
  'evolution_saturation',
  'failure_loop_detected',
  'high_failure_ratio',

  // -- src/gep/mutation.js: opportunity signals -----------------------------
  'issue_already_resolved',
  'openclaw_self_healed',

  // -- src/gep/taskReceiver.js: Hub task markers ---------------------------
  'external_task',
  'bounty_task',
];

// Signal families whose members are legitimate even though they carry a
// detail suffix. src/gep/signals.js and src/gep/mutation.js both match these
// with startsWith(), so the suffix is part of the contract.
var PREFIXED_SIGNAL_PREFIXES = [
  'errsig:',                    // signals.js: 'errsig:' + clipped error line
  'errsig_norm:',               // mutation.js: hasErrorishSignal()
  'recurring_errsig',           // signals.js: 'recurring_errsig(3x):...'
  'user_feature_request:',      // signals.js: 'user_feature_request:' + snippet
  'user_improvement_suggestion:',
  'missing_integration_file:',
  'high_tool_usage:',
  'repeated_tool_usage:',
  'ban_gene:',
];

// Near-synonyms observed on Hub tasks and in task titles, mapped onto the
// canonical signal they stand for. Only tokens that can be justified from the
// detectors in src/gep/signals.js are listed here.
var ALIAS_MAP = {
  // perf_bottleneck -- signals.js matches /slow|timeout|latency|bottleneck/ ...
  'performance': 'perf_bottleneck',
  'bottleneck': 'perf_bottleneck',
  'perf': 'perf_bottleneck',
  'slow': 'perf_bottleneck',
  'latency': 'perf_bottleneck',
  'timeout': 'perf_bottleneck',

  // user_feature_request -- signals.js matches /add|implement|create|.../ + feature
  'feature': 'user_feature_request',
  'feature_request': 'user_feature_request',

  // capability_gap -- signals.js matches /not supported|cannot|unsupported|.../
  'capability': 'capability_gap',
  'capability_request': 'capability_gap',
  'unsupported': 'capability_gap',

  // user_improvement_suggestion -- signals.js matches /improve|enhance|.../
  'improve': 'user_improvement_suggestion',
  'improvement': 'user_improvement_suggestion',

  // log_error -- mutation.js hasErrorishSignal() treats log_error as the
  // canonical error marker.
  'error': 'log_error',
};

// Canonical names that carry a numeric suffix (src/gep/signals.js pushes
// 'consecutive_failure_streak_' + N).
var KNOWN_SIGNAL_PATTERNS = [
  /^consecutive_failure_streak_\d+$/,
];

var KNOWN_SIGNAL_SET = new Set(KNOWN_SIGNALS);

// Structural noise that must never become a signal:
//   * markdown emphasis / tool-output wrappers: "**toolresult**:"
//   * bracketed fragments: "[error]"
//   * embedded whitespace: "errsig" details are handled by the prefix rule
//   * a colon that is not part of a known prefix: "detected:"
//   * pure punctuation or digits: "---", "42"
var RE_MARKUP = /\*\*|\[|\]/;
var RE_WHITESPACE = /\s/;
var RE_COLON = /:/;
var RE_PURE_PUNCT = /^[\p{P}\p{S}]+$/u;
var RE_PURE_DIGITS = /^\d+$/;

function normalizeToken(token) {
  if (token === null || token === undefined) return '';
  return String(token).toLowerCase().trim();
}

function hasKnownPrefix(token) {
  for (var i = 0; i < PREFIXED_SIGNAL_PREFIXES.length; i++) {
    if (token.indexOf(PREFIXED_SIGNAL_PREFIXES[i]) === 0) return true;
  }
  return false;
}

function matchesKnownPattern(token) {
  for (var i = 0; i < KNOWN_SIGNAL_PATTERNS.length; i++) {
    if (KNOWN_SIGNAL_PATTERNS[i].test(token)) return true;
  }
  return false;
}

// True when the token is structurally incapable of being a signal.
function isStructurallyInvalid(token) {
  if (!token) return true;
  if (RE_MARKUP.test(token)) return true;
  if (RE_WHITESPACE.test(token)) return true;
  if (RE_COLON.test(token)) return true;
  if (RE_PURE_PUNCT.test(token)) return true;
  if (RE_PURE_DIGITS.test(token)) return true;
  return false;
}

/**
 * Is this token a signal this repository already knows?
 *
 * Canonical names, their detail-suffixed families (errsig:, recurring_errsig,
 * ...) and the numbered failure-streak names are known. Aliases are not: they
 * are near-synonyms that still have to be rewritten, so use resolveSignal() or
 * sanitizeSignals() for those.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isKnownSignal(token) {
  var t = normalizeToken(token);
  if (!t) return false;
  if (KNOWN_SIGNAL_SET.has(t)) return true;
  if (matchesKnownPattern(t)) return true;
  if (hasKnownPrefix(t)) return true;
  return false;
}

/**
 * Resolve a token onto a canonical signal.
 *
 * @param {string} token
 * @returns {string|null} canonical name, the detail-suffixed token itself for
 *   known families, or null when the token is not a signal at all.
 */
function resolveSignal(token) {
  var t = normalizeToken(token);
  if (!t) return null;
  if (hasKnownPrefix(t)) return t;
  if (Object.prototype.hasOwnProperty.call(ALIAS_MAP, t)) t = ALIAS_MAP[t];
  if (KNOWN_SIGNAL_SET.has(t)) return t;
  if (matchesKnownPattern(t)) return t;
  return null;
}

/**
 * Normalize a list of raw signal tokens into clean, canonical signals.
 *
 * Rules (in order):
 *   1. lowercase and trim every token;
 *   2. keep tokens that belong to a known detail-suffixed family
 *      (errsig:, recurring_errsig, user_feature_request:, ...) verbatim;
 *   3. rewrite aliases onto their canonical signal;
 *   4. keep tokens that are canonical signal names;
 *   5. drop tokens that carry markdown wrappers, brackets, whitespace, a colon
 *      outside a known prefix, or that are pure punctuation / digits;
 *   6. drop every other unknown fragment (prose) unless opts.allowUnknown is
 *      true;
 *   7. de-duplicate, preserving first-seen order.
 *
 * @param {string[]} tokens
 * @param {{ allowUnknown?: boolean }} [opts]
 * @returns {string[]}
 */
function sanitizeSignals(tokens, opts) {
  var options = opts || {};
  var allowUnknown = options.allowUnknown === true;
  var list = Array.isArray(tokens) ? tokens : (tokens ? [tokens] : []);
  var out = [];
  var seen = new Set();

  for (var i = 0; i < list.length; i++) {
    var t = normalizeToken(list[i]);
    if (!t) continue;

    // 2. legitimate detail-suffixed signal families survive untouched.
    if (hasKnownPrefix(t)) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
      continue;
    }

    // 3. alias rewrite.
    if (Object.prototype.hasOwnProperty.call(ALIAS_MAP, t)) t = ALIAS_MAP[t];

    // 4. canonical names survive.
    if (KNOWN_SIGNAL_SET.has(t) || matchesKnownPattern(t)) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
      continue;
    }

    // 5. structural noise never survives.
    if (isStructurallyInvalid(t)) continue;

    // 6. unknown prose is dropped unless the caller opts in.
    if (allowUnknown && !seen.has(t)) { seen.add(t); out.push(t); }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Error evidence classification
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
// --------------
// src/gep/signals.js used to decide "is there a live error?" with ONE regex
// applied to the WHOLE signal corpus:
//
//   /\[error\]|error:|exception:|iserror":true|"status":\s*"error"|...
//
// The corpus is the session transcript + today's log + memory + user notes +
// the integration report. The transcript holds the agent's OWN tool output,
// so a single stale toolResult that a previous turn quoted verbatim
// ("status":"failed", "isError":true) kept the coarse `log_error` tag firing
// forever. Downstream that tag forces the mutation category to `repair`
// (src/gep/mutation.js) and to `repair` again in src/gep/solidify.js, so the
// cycle could never leave the repair gene while the stagnation guard kept
// reporting a plateau. Each cycle then re-mined its own history: a
// self-feeding loop.
//
// The question the protocol actually asks is "is this failure HAPPENING, or
// is this a RECORD of a failure that already happened?". This module answers
// it line by line:
//
//   * a DIRECT failure statement ("error:", "exception:", "[error]",
//     "TypeError:") is live evidence - always;
//   * a QUOTED artifact (a serialized toolResult, a report quoting another
//     component's status, an already-resolved failure) is NOT live evidence;
//   * a report that states the operation SUCCEEDED ("exec completed",
//     "code 0", "status=ok") is a success even when it quotes another
//     component's status text.
//
// A real fault is never hidden: a live fault is narrated in prose ("error:
// cannot read file"), and prose is a direct statement. A direct statement
// that sits OUTSIDE a quoted payload also stays live.
// ---------------------------------------------------------------------------

// A DIRECT failure statement: the line itself says the operation failed.
//   "error: cannot read file" / "[error] TypeError: x" / "exception: boom"
//   / "ReferenceError: tools is not defined"
var DIRECT_ERROR_RE = /\b(?:type|reference|syntax|range)error\b\s*:|\berror\s*:|\bexception\s*:|\[error\b|\[error\]/i;

// An INDIRECT failure marker: the line reports a failing status without
// stating the failure itself ("news-collect-reuters: status error").
var STRONG_ERROR_RE = /\b(?:type|reference|syntax|range)error\b\s*:|\berror\s*:|\bexception\s*:|\[error\b|\[error\]|status\s+error|status["']?\s*:\s*["']?failed/i;

// The report says the OPERATION itself succeeded.
var SUCCESS_REPORT_RE = /\b(?:exec|execution|command|step|operation|task|run|job|process|script)\s+(?:completed|finished|succeeded|done)\b|\bcompleted\s+successfully\b|\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s*[:=]?\s*0\b|\bcode\s*[:=]?\s*0\b|\bstatus\s*[:=]\s*(?:ok|success|successful|done)\b/i;

// Weak markers, but NOT when negated - "无异常：9" / "没有错误：" are healthy
// status lines, not failures.
var WEAK_ERROR_RE = /(?<!(?:没有|无|未|没|非))(?<![有无未没非])(?:错误|异常|报错|失败)\s*[：:]/;

// A heartbeat reply is a status report, never a failure.
var HEARTBEAT_STATUS_RE = /HEARTBEAT_OK/i;

// A QUOTED artifact: the line is a RECORD of a result, not this system's
// own live failure.
var QUOTED_ARTIFACT_RES = [
  /\*\*+\s*TOOLRESULT\s*\*\*+/i,   // "**TOOLRESULT**: {...}"
  /\[\s*TOOLRESULT\s*\]/i,          // "[TOOLRESULT] {...}"
  /\*\*+\s*CUSTOM\s*\*\*/i,         // "**CUSTOM**:"
  /"toolResult"/i,                     // serialized tool result
  /"role"\s*:\s*"tool"/i,
  /\btool_result\b/i,
  /"?isError"?\s*:\s*true/i,           // "isError":true
];

// An already-resolved failure: the text says the problem was handled.
var RESOLVED_RE = /\balready resolved\b|\bpreviously failed\b|\bhas been fixed\b|\bwas fixed\b|\bsuperseded\b|\bresolved after\b|已解决|已修复|已恢复/i;

// A serialized JSON object inside a line.
var JSON_PAYLOAD_RE = /\{[\s\S]*\}/;
// A quoted key inside a payload.
var JSON_KEY_RE = /"[^"]{1,60}"\s*:/;

/**
 * Does this line contain a serialized JSON payload?
 *
 * @param {string} line
 * @returns {boolean}
 */
function hasJsonPayload(line) {
  var m = String(line || '').match(JSON_PAYLOAD_RE);
  return !!(m && JSON_KEY_RE.test(m[0]));
}

/**
 * Remove the serialized payload from a line, so the remaining prose can be
 * judged on its own. A failure statement OUTSIDE the payload is live; a
 * failure statement INSIDE it is quoted.
 *
 * @param {string} line
 * @returns {string}
 */
function stripJsonPayload(line) {
  return String(line || '').replace(JSON_PAYLOAD_RE, ' ');
}

/**
 * Is this line a quoted / already-resolved artifact?
 *
 * @param {string} line
 * @returns {boolean}
 */
function isQuotedArtifact(line) {
  var s = String(line || '');
  if (!s) return false;
  for (var i = 0; i < QUOTED_ARTIFACT_RES.length; i++) {
    if (QUOTED_ARTIFACT_RES[i].test(s)) return true;
  }
  return false;
}

/**
 * Classify the error evidence carried by a set of lines.
 *
 * The verdict is the single source of truth for BOTH the coarse `log_error`
 * tag and the fine `errsig:` signature, so the two can never disagree.
 *
 * @param {string[]|string} lines
 * @returns {{live:boolean, direct:boolean, quoted:boolean, success:boolean,
 *            line:string|null, lines:string[], reason:string}}
 */
function classifyErrorEvidence(lines) {
  var list = Array.isArray(lines) ? lines : (typeof lines === 'string' ? lines.split('\n') : []);
  var verdict = {
    live: false,
    direct: false,
    quoted: false,
    success: false,
    line: null,
    lines: [],
    reason: 'no_error_evidence',
  };

  for (var i = 0; i < list.length; i++) {
    var raw = list[i];
    if (raw === null || raw === undefined) continue;
    var line = String(raw).trim();
    if (!line) continue;

    var payload = hasJsonPayload(line);
    var outside = payload ? stripJsonPayload(line) : line;
    var directOutside = DIRECT_ERROR_RE.test(outside);
    var isDirect = directOutside || DIRECT_ERROR_RE.test(line);

    // A success report is a success - even when it quotes another
    // component's status text ("exec completed (code 0) :: reuters status
    // error| ..."). A DIRECT failure statement still wins: the operation
    // itself failed.
    if (SUCCESS_REPORT_RE.test(line) && !directOutside) {
      verdict.success = true;
      continue;
    }

    // A quoted / already-resolved artifact is a record of a failure, not a
    // live failure. It must never produce log_error. A direct statement
    // OUTSIDE the payload keeps the line live.
    if (payload) {
      if (!directOutside) {
        verdict.quoted = true;
        continue;
      }
    } else if (isQuotedArtifact(line)) {
      verdict.quoted = true;
      continue;
    } else if (!isDirect && RESOLVED_RE.test(line)) {
      // An already-resolved failure is a record, not a live fault. A direct
      // failure statement is never downgraded to "resolved".
      verdict.quoted = true;
      continue;
    }

    var isStrong = STRONG_ERROR_RE.test(line);
    var isWeak = WEAK_ERROR_RE.test(line);
    if (!isDirect && !isStrong && !isWeak) continue;

    // A heartbeat status line is noise, not a failure.
    if (!isDirect && HEARTBEAT_STATUS_RE.test(line)) continue;

    verdict.live = true;
    if (isDirect) verdict.direct = true;
    verdict.lines.push(line);
    if (!verdict.line) verdict.line = line;
  }

  if (verdict.live) {
    verdict.reason = verdict.direct ? 'live_direct_failure' : 'live_indirect_failure';
  } else if (verdict.quoted) {
    verdict.reason = 'quoted_artifact_only';
  } else if (verdict.success) {
    verdict.reason = 'success_report_only';
  }
  return verdict;
}

module.exports = {
  KNOWN_SIGNALS: KNOWN_SIGNALS,
  KNOWN_SIGNAL_PATTERNS: KNOWN_SIGNAL_PATTERNS,
  PREFIXED_SIGNAL_PREFIXES: PREFIXED_SIGNAL_PREFIXES,
  ALIAS_MAP: ALIAS_MAP,
  sanitizeSignals: sanitizeSignals,
  isKnownSignal: isKnownSignal,
  resolveSignal: resolveSignal,
  normalizeToken: normalizeToken,
  classifyErrorEvidence: classifyErrorEvidence,
  isQuotedArtifact: isQuotedArtifact,
  hasJsonPayload: hasJsonPayload,
  stripJsonPayload: stripJsonPayload,
  DIRECT_ERROR_RE: DIRECT_ERROR_RE,
  STRONG_ERROR_RE: STRONG_ERROR_RE,
  SUCCESS_REPORT_RE: SUCCESS_REPORT_RE,
  WEAK_ERROR_RE: WEAK_ERROR_RE,
};
