// Opportunity signal names (shared with mutation.js and personality.js).
var OPPORTUNITY_SIGNALS = [
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
];

function hasOpportunitySignal(signals) {
  var list = Array.isArray(signals) ? signals : [];
  for (var i = 0; i < OPPORTUNITY_SIGNALS.length; i++) {
    var name = OPPORTUNITY_SIGNALS[i];
    if (list.includes(name)) return true;
    if (list.some(function (s) { return String(s).startsWith(name + ':'); })) return true;
  }
  return false;
}

// Build a de-duplication set from recent evolution events.
// Returns an object: { suppressedSignals: Set<string>, recentIntents: string[], consecutiveRepairCount: number }
function analyzeRecentHistory(recentEvents) {
  if (!Array.isArray(recentEvents) || recentEvents.length === 0) {
    return { suppressedSignals: new Set(), recentIntents: [], consecutiveRepairCount: 0 };
  }
  // Take only the last 10 events
  var recent = recentEvents.slice(-10);

  // Count consecutive same-intent runs at the tail
  var consecutiveRepairCount = 0;
  for (var i = recent.length - 1; i >= 0; i--) {
    if (recent[i].intent === 'repair') {
      consecutiveRepairCount++;
    } else {
      break;
    }
  }

  // Count signal frequency in last 8 events: signal -> count
  var signalFreq = {};
  var geneFreq = {};
  var tail = recent.slice(-8);
  for (var j = 0; j < tail.length; j++) {
    var evt = tail[j];
    var sigs = Array.isArray(evt.signals) ? evt.signals : [];
    for (var k = 0; k < sigs.length; k++) {
      var s = String(sigs[k]);
      // Normalize: strip details suffix so frequency keys match dedup filter keys
      var key = s.startsWith('errsig:') ? 'errsig'
        : s.startsWith('recurring_errsig') ? 'recurring_errsig'
        : s.startsWith('user_feature_request:') ? 'user_feature_request'
        : s.startsWith('user_improvement_suggestion:') ? 'user_improvement_suggestion'
        : s;
      signalFreq[key] = (signalFreq[key] || 0) + 1;
    }
    var genes = Array.isArray(evt.genes_used) ? evt.genes_used : [];
    for (var g = 0; g < genes.length; g++) {
      geneFreq[String(genes[g])] = (geneFreq[String(genes[g])] || 0) + 1;
    }
  }

  // Suppress signals that appeared in 3+ of the last 8 events (they are being over-processed)
  var suppressedSignals = new Set();
  var entries = Object.entries(signalFreq);
  for (var ei = 0; ei < entries.length; ei++) {
    if (entries[ei][1] >= 3) {
      suppressedSignals.add(entries[ei][0]);
    }
  }

  var recentIntents = recent.map(function(e) { return e.intent || 'unknown'; });

  // Count empty cycles (blast_radius.files === 0) in last 8 events.
  // High ratio indicates the evolver is spinning without producing real changes.
  var emptyCycleCount = 0;
  for (var ec = 0; ec < tail.length; ec++) {
    var br = tail[ec].blast_radius;
    var em = tail[ec].meta && tail[ec].meta.empty_cycle;
    if (em || (br && br.files === 0 && br.lines === 0)) {
      emptyCycleCount++;
    }
  }

  // Count consecutive empty cycles at the tail (not just total in last 8).
  // This detects saturation: the evolver has exhausted innovation space and keeps producing
  // zero-change cycles. Used to trigger graceful degradation to steady-state mode.
  var consecutiveEmptyCycles = 0;
  for (var se = recent.length - 1; se >= 0; se--) {
    var seBr = recent[se].blast_radius;
    var seEm = recent[se].meta && recent[se].meta.empty_cycle;
    if (seEm || (seBr && seBr.files === 0 && seBr.lines === 0)) {
      consecutiveEmptyCycles++;
    } else {
      break;
    }
  }

  // Count consecutive failures at the tail of recent events.
  // This tells the evolver "you have been failing N times in a row -- slow down."
  var consecutiveFailureCount = 0;
  for (var cf = recent.length - 1; cf >= 0; cf--) {
    var outcome = recent[cf].outcome;
    if (outcome && outcome.status === 'failed') {
      consecutiveFailureCount++;
    } else {
      break;
    }
  }

  // Count total failures in last 8 events (failure ratio).
  var recentFailureCount = 0;
  for (var rf = 0; rf < tail.length; rf++) {
    var rfOut = tail[rf].outcome;
    if (rfOut && rfOut.status === 'failed') recentFailureCount++;
  }

  return {
    suppressedSignals: suppressedSignals,
    recentIntents: recentIntents,
    consecutiveRepairCount: consecutiveRepairCount,
    emptyCycleCount: emptyCycleCount,
    consecutiveEmptyCycles: consecutiveEmptyCycles,
    consecutiveFailureCount: consecutiveFailureCount,
    recentFailureCount: recentFailureCount,
    recentFailureRatio: tail.length > 0 ? recentFailureCount / tail.length : 0,
    signalFreq: signalFreq,
    geneFreq: geneFreq,
  };
}

// --- Error signature extraction helpers ---------------------------------------
//
// The signal corpus concatenates the session transcript, today's log, memory,
// user notes and the integration report. A tool-result status summary such as
//   "**TOOLRESULT**: count 9 | 连续错误: 1 !! news-collect-reuters err 1
//    /dev/nvme0n1p2 116G 86G 25G 79% / 14:09:04 up 2 days, 12:48, 1 user,
//    load average: 0.33, 0.29, 0.25"
// used to win the find() race, because its only "error" token was a counter
// field ("连续错误: 1"). Two consequences:
//   1. a genuine error further down the corpus was masked;
//   2. the captured line was emitted verbatim, injecting volatile machine state
//      (disk %, uptime, load average, timestamps, the TOOLRESULT wrapper) into
//      the GEP prompt and into the stored error signature. The raw string
//      changed on every run, so the memory graph and the recurring-error
//      detection never accumulated for the same underlying failure.
// Fix: prefer a STRONG error token, fall back to a weak one, and strip the
// volatile runtime state from whatever is emitted.

// Strong, unambiguous error markers (a real failure statement).
var STRONG_ERROR_RE = /\b(?:type|reference|syntax)error\b\s*:|\berror\s*:|\bexception\s*:|\[error\b|\[error\]|status\s+error/i;
// Weak markers, but NOT when negated - "无异常：9" / "没有错误：" are healthy
// status lines, not failures.
var WEAK_ERROR_RE = /(?<!(?:没有|无|未|没|非))(?<![有无未没非])(?:错误|异常|报错|失败)\s*[：:]/;

// Machine state, not failure description. Applied to the captured line.
var VOLATILE_STATE_RULES = [
  // tool-result wrapper: "**TOOLRESULT**:" / "[TOOLRESULT]"
  { re: /\*+\s*TOOLRESULT\s*\*+\s*[:：]?/gi, rep: ' ' },
  { re: /\[\s*TOOLRESULT\s*\]/gi, rep: ' ' },
  // status prefix: "count 9 |"
  { re: /\bcount\s*\d+\s*\|/gi, rep: ' ' },
  // label-only counters: "连续错误: 1", "失败次数: 3"
  { re: /(?:连续|累计)?\s*(?:错误|异常|报错|失败)\s*(?:次数|count)?\s*[：:]\s*\d+\b/g, rep: ' ' },
  // disk usage: "/dev/nvme0n1p2 116G 86G 25G 79%"
  { re: /\/dev\/\S+\s+[\d.]+[KMGT]?\s+[\d.]+[KMGT]?\s+[\d.]+[KMGT]?\s+\d+%/gi, rep: ' ' },
  { re: /\/dev\/\S+\s+\d+(?:\.\d+)?%/gi, rep: ' ' },
  // uptime block: "14:09:04 up 2 days, 12:48, 1 user"
  { re: /(?:\b\d{1,2}:\d{2}(?::\d{2})?\b,?\s*)?\bup\s+\d+\s+days?(?:\s*,\s*\d{1,2}:\d{2}(?::\d{2})?)?(?:\s*,\s*\d+\s+users?)?/gi, rep: ' ' },
  // load average: "load average: 0.33, 0.29, 0.25"
  { re: /\bload\s+average\s*:\s*[\d.,\s]+/gi, rep: ' ' },
];

// Remove volatile runtime state (tool wrappers, counters, machine stats,
// timestamps) from a captured line. Keeps the informative head intact.
function stripVolatileRuntimeState(text) {
  var s = String(text || '');
  if (!s) return '';
  for (var i = 0; i < VOLATILE_STATE_RULES.length; i++) {
    try { s = s.replace(VOLATILE_STATE_RULES[i].re, VOLATILE_STATE_RULES[i].rep); } catch (e) {}
  }
  // Leading date / timestamp stamp.
  s = s.replace(/^\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\s*/, '');
  // Collapse whitespace and drop separators left dangling by the stripping.
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+([,;|!])/g, '$1');
  s = s.replace(/([,;|!])\s+/g, '$1 ');
  s = s.replace(/^[\s|,;!:*]+/, '');
  s = s.replace(/[\s|,;!:/\-]+$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

// Pick the most informative error line: strong error tokens first, weak ones
// as fallback. Returns the cleaned line (volatile state already stripped).
// A heartbeat reply ("HEARTBEAT_OK ...") is a status report, never a failure.
var HEARTBEAT_STATUS_RE = /HEARTBEAT_OK/i;

function pickErrorSignatureLine(lines) {
  var list = Array.isArray(lines) ? lines : [];
  var strong = [];
  var weak = [];
  for (var i = 0; i < list.length; i++) {
    var l = String(list[i] || '');
    if (!l) continue;
    if (STRONG_ERROR_RE.test(l)) { strong.push(l); continue; }
    if (WEAK_ERROR_RE.test(l)) {
      // A weak-only match on a heartbeat status line is noise, not a failure.
      if (HEARTBEAT_STATUS_RE.test(l)) continue;
      weak.push(l);
    }
  }
  var candidates = strong.concat(weak);
  for (var c = 0; c < candidates.length; c++) {
    var cleaned = stripVolatileRuntimeState(candidates[c]);
    // Require some informative content; a pure counter line carries no signal.
    if (cleaned && cleaned.length >= 3) return cleaned;
  }
  return null;
}

// --- Tool usage: repetition vs. volume -------------------------------------
// A tool-usage signal must be able to tell "the same command ran again" from
// "many different commands ran". Only the command text can do that, so the
// transcript carries a command signature next to every exec marker:
//   **ASSISTANT**: <prose> [TOOL: exec] [CMD: <signature>]
// Without it every exec call looks identical and a signal literally named
// "repeated" could never measure repetition.
var HIGH_TOOL_USAGE_THRESHOLD = 10; // calls of one tool (tools without a command text)
// Distinct commands of ONE tool. A session that runs 10+ different one-shot
// commands is normal engineering work, so the threshold sits clearly above
// that: the signal marks a genuine outlier instead of being always on.
var HIGH_DISTINCT_COMMAND_THRESHOLD = 15;
var REPEATED_COMMAND_THRESHOLD = 3; // identical normalized command occurrences

// A performance incident needs an incident context. Bare words such as
// "timeout" are configuration noise (timeout=1800, --timeout-seconds 1800,
// timeoutSeconds, lastErrorReason=timeout) and must not fire the signal.
var PERF_INCIDENT_RE = /\b(?:timed[\s-]?out|time[\s-]out|timeout\s+exceed(?:ed|ing)?|exceeded\s+(?:[a-z0-9_.]+\s+){0,3}timeout|oom[\s-]?kill(?:ed)?|out\s+of\s+memory|memory\s+limit\s+exceeded|high\s+cpu|cpu\s+spike|cpu\s+usage\s+above|took\s+too\s+long|latency\s+spike|high\s+latency|slow\s+response|slow\s+query|performance\s+issue|high\s+memory)\b/i;

// Normalize a command so volatile parts (numbers, temp paths, timestamps,
// durations, uuids) do not make two runs of the same command look different.
function normalizeCommand(command) {
  var s = String(command || '');
  if (!s.trim()) return '';
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g, '<ts>');
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|s|m|h)\b/gi, '<dur>');
  // mktemp-style random names (/tmp/tmpA1b2C3d4) are volatile. Keep the rest
  // of the path: "/tmp/dir0" and "/tmp/dir1" are DIFFERENT targets.
  s = s.replace(/\/tmp\/[^\s"']*tmp[A-Za-z0-9]{6,}/g, '/tmp/<tmp>');
  s = s.replace(/\btmp[A-Za-z0-9]{8,}\b/g, '<tmp>');
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, '#');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // The length is part of the key: two commands that share a long prefix but
  // differ later must not collapse into a single "repeated" command.
  return s.slice(0, 160) + '|' + s.length;
}

// Extract the exec command signatures carried by the transcript.
function extractExecCommands(corpus) {
  var text = String(corpus || '');
  var out = [];
  var re = /\[CMD:\s*([^\]]{1,400})\]/gi;
  var m;
  while ((m = re.exec(text)) !== null) {
    var parts = String(m[1]).split(' ;; ');
    for (var i = 0; i < parts.length; i++) {
      var cmd = parts[i].trim();
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

function extractSignals({ recentSessionTranscript, todayLog, memorySnippet, userSnippet, recentEvents, integrationReport }) {
  var signals = [];
  var corpus = [
    String(recentSessionTranscript || ''),
    String(todayLog || ''),
    String(memorySnippet || ''),
    String(userSnippet || ''),
    String(integrationReport || ''),
  ].join('\n');
  // Command signatures are metadata, not prose. Strip them before the
  // semantic scans: otherwise a shell command can fake a feature request
  // ("write ..."), an error or a performance incident.
  var proseCorpus = corpus.replace(/\[CMD:\s*[^\]]{0,400}\]/g, ' ');
  var lower = proseCorpus.toLowerCase();

  // Analyze recent evolution history for de-duplication
  var history = analyzeRecentHistory(recentEvents || []);

  // --- Defensive signals (errors, missing resources) ---

  // Refined error detection regex to avoid false positives on "fail"/"failed" in normal text.
  // We prioritize structured error markers ([error], error:, exception:) and specific JSON patterns.
  var errorHit = /\[error\]|error:|exception:|iserror":true|"status":\s*"error"|"status":\s*"failed"|错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/.test(lower);
  if (errorHit) signals.push('log_error');

  // Error signature (more reproducible than a coarse "log_error" tag).
  try {
    var lines = corpus
      .split('\n')
      .map(function (l) { return String(l || '').trim(); })
      .filter(Boolean);

    var errLine = pickErrorSignatureLine(lines);

    if (errLine) {
      var clipped = errLine.replace(/\s+/g, ' ').slice(0, 260);
      signals.push('errsig:' + clipped);
    }
  } catch (e) {}

  if (lower.includes('memory.md missing')) signals.push('memory_missing');
  if (lower.includes('user.md missing')) signals.push('user_missing');
  if (lower.includes('key missing')) signals.push('integration_key_missing');

  // Missing cross-skill integration file (e.g. "skills/feishu-doc/create.js").
  // The generic log_error tag hides WHICH file is missing, so the agent keeps
  // rediscovering the same path with repeated exec calls. Emit the exact path.
  //
  // Scan ONLY the live integration report, never the whole corpus: the corpus
  // contains earlier gep_prompt files and logs that quote previous cycles'
  // signal strings, so a corpus-wide regex re-detects its own output forever
  // and the same "missing" path echoes forever after it is fixed.
  var missingDepRe = /missing_integration_file:\s*([^\s)]+)/g;
  var missingDepMatch;
  var missingDeps = [];
  var depCorpus = String(integrationReport || '');
  while ((missingDepMatch = missingDepRe.exec(depCorpus)) !== null) {
    var depPath = missingDepMatch[1];
    if (depPath && missingDeps.indexOf(depPath) === -1) missingDeps.push(depPath);
  }
  if (missingDeps.length > 0) {
    if (signals.indexOf('integration_key_missing') === -1) signals.push('integration_key_missing');
    for (var md = 0; md < missingDeps.length; md++) {
      signals.push('missing_integration_file:' + missingDeps[md]);
    }
  }
  if (lower.includes('no session logs found') || lower.includes('no jsonl files')) signals.push('session_logs_missing');
  // if (lower.includes('pgrep') || lower.includes('ps aux')) signals.push('windows_shell_incompatible');
  if (lower.includes('path.resolve(__dirname, \'../../../')) signals.push('path_outside_workspace');

  // Protocol-specific drift signals
  if (lower.includes('prompt') && !lower.includes('evolutionevent')) signals.push('protocol_drift');

  // --- Recurring error detection (robustness signals) ---
  // Count repeated identical errors -- these indicate systemic issues that need automated fixes
  try {
    var errorCounts = {};
    var errPatterns = proseCorpus.match(/(?:LLM error|"error"|"status":\s*"error")[^}]{0,200}/gi) || [];
    for (var ep = 0; ep < errPatterns.length; ep++) {
      // Normalize to a short key
      var key = errPatterns[ep].replace(/\s+/g, ' ').slice(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    var recurringErrors = Object.entries(errorCounts).filter(function (e) { return e[1] >= 3; });
    if (recurringErrors.length > 0) {
      signals.push('recurring_error');
      // Include the top recurring error signature for the agent to diagnose
      var topErr = recurringErrors.sort(function (a, b) { return b[1] - a[1]; })[0];
      signals.push('recurring_errsig(' + topErr[1] + 'x):' + topErr[0].slice(0, 150));
    }
  } catch (e) {}

  // --- Unsupported input type (e.g. GIF, video formats the LLM can't handle) ---
  if (/unsupported mime|unsupported.*type|invalid.*mime/i.test(lower)) {
    signals.push('unsupported_input_type');
  }

  // --- Opportunity signals (innovation / feature requests) ---
  // Support 4 languages: EN, ZH-CN, ZH-TW, JA. Attach snippet for selector/prompt use.

  var featureRequestSnippet = '';
  var featEn = proseCorpus.match(/\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,120}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i);
  if (featEn) featureRequestSnippet = featEn[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!featureRequestSnippet && /\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower)) {
    var featWant = proseCorpus.match(/.{0,80}\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b.{0,80}/i);
    featureRequestSnippet = featWant ? featWant[0].replace(/\s+/g, ' ').trim().slice(0, 200) : 'feature request';
  }
  if (!featureRequestSnippet && /加个|实现一下|做个|想要\s*一个|需要\s*一个|帮我加|帮我开发|加一下|新增一个|加个功能|做个功能|我想/.test(proseCorpus)) {
    var featZh = proseCorpus.match(/.{0,100}(加个|实现一下|做个|想要\s*一个|需要\s*一个|帮我加|帮我开发|加一下|新增一个|加个功能|做个功能).{0,100}/);
    if (featZh) featureRequestSnippet = featZh[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!featureRequestSnippet && /我想/.test(proseCorpus)) {
      var featWantZh = proseCorpus.match(/我想\s*[，,\.。、\s]*([\s\S]{0,400})/);
      featureRequestSnippet = featWantZh ? (featWantZh[1].replace(/\s+/g, ' ').trim().slice(0, 200) || '功能需求') : '功能需求';
    }
    if (!featureRequestSnippet) featureRequestSnippet = '功能需求';
  }
  if (!featureRequestSnippet && /加個|實現一下|做個|想要一個|請加|新增一個|加個功能|做個功能|幫我加/.test(proseCorpus)) {
    var featTw = proseCorpus.match(/.{0,100}(加個|實現一下|做個|想要一個|請加|新增一個|加個功能|做個功能|幫我加).{0,100}/);
    featureRequestSnippet = featTw ? featTw[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '功能需求';
  }
  if (!featureRequestSnippet && /追加|実装|作って|機能を|追加して|が欲しい|を追加|してほしい/.test(proseCorpus)) {
    var featJa = proseCorpus.match(/.{0,100}(追加|実装|作って|機能を|追加して|が欲しい|を追加|してほしい).{0,100}/);
    featureRequestSnippet = featJa ? featJa[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '機能要望';
  }
  if (featureRequestSnippet || /\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,60}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i.test(proseCorpus) ||
      /\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower) ||
      /加个|实现一下|做个|想要\s*一个|需要\s*一个|帮我加|帮我开发|加一下|新增一个|加个功能|做个功能|我想/.test(proseCorpus) ||
      /加個|實現一下|做個|想要一個|請加|新增一個|加個功能|做個功能|幫我加/.test(proseCorpus) ||
      /追加|実装|作って|機能を|追加して|が欲しい|を追加|してほしい/.test(proseCorpus)) {
    signals.push('user_feature_request:' + (featureRequestSnippet || ''));
  }

  // user_improvement_suggestion: 4 languages + snippet
  var improvementSnippet = '';
  if (!errorHit) {
    var impEn = proseCorpus.match(/.{0,80}\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b.{0,80}/i);
    if (impEn) improvementSnippet = impEn[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!improvementSnippet && /改进一下|优化一下|简化|重构|整理一下|弄得更好/.test(proseCorpus)) {
      var impZh = proseCorpus.match(/.{0,100}(改进一下|优化一下|简化|重构|整理一下|弄得更好).{0,100}/);
      improvementSnippet = impZh ? impZh[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '改进建议';
    }
    if (!improvementSnippet && /改進一下|優化一下|簡化|重構|整理一下|弄得更好/.test(proseCorpus)) {
      var impTw = proseCorpus.match(/.{0,100}(改進一下|優化一下|簡化|重構|整理一下|弄得更好).{0,100}/);
      improvementSnippet = impTw ? impTw[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '改進建議';
    }
    if (!improvementSnippet && /改善|最適化|簡素化|リファクタ|良くして|改良/.test(proseCorpus)) {
      var impJa = proseCorpus.match(/.{0,100}(改善|最適化|簡素化|リファクタ|良くして|改良).{0,100}/);
      improvementSnippet = impJa ? impJa[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '改善要望';
    }
    var hasImprovement = improvementSnippet ||
      /\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b/i.test(lower) ||
      /改进一下|优化一下|简化|重构|整理一下|弄得更好/.test(proseCorpus) ||
      /改進一下|優化一下|簡化|重構|整理一下|弄得更好/.test(proseCorpus) ||
      /改善|最適化|簡素化|リファクタ|良くして|改良/.test(proseCorpus);
    if (hasImprovement) {
      signals.push('user_improvement_suggestion:' + (improvementSnippet || ''));
    }
  }

  // perf_bottleneck: performance INCIDENTS only.
  // The old regex matched the bare words timeout / slow / latency / oom
  // anywhere in the corpus, so configuration values ("timeout=1800",
  // "--timeout-seconds 1800") and JSON field names
  // ("lastErrorReason=timeout") kept the signal permanently on even when
  // nothing was slow. Require an incident context: the phrase has to
  // describe something that actually timed out, ran out of memory or became
  // slow. Genuine incidents ("cron: job execution timed out") still match.
  if (PERF_INCIDENT_RE.test(proseCorpus)) {
    signals.push('perf_bottleneck');
  }

  // capability_gap: something is explicitly unsupported or missing
  if (/\b(not supported|cannot|doesn'?t support|no way to|missing feature|unsupported|not available|not implemented|no support for)\b/i.test(lower)) {
    // Only fire if it is not just a missing file/config signal
    if (!signals.includes('memory_missing') && !signals.includes('user_missing') && !signals.includes('session_logs_missing')) {
      signals.push('capability_gap');
    }
  }

  // --- Tool Usage Analytics ---
  // Tool-usage signals must measure REPETITION, not volume. The old code
  // counted total calls: a session running 30 DIFFERENT one-shot commands
  // scored exactly like one session repeating a SINGLE command 30 times, so
  // "repeated_tool_usage" could never clear itself.
  var toolUsage = {};
  var toolMatches = corpus.match(/\[TOOL:\s*([\w-]+)\]/g) || [];

  for (var i = 0; i < toolMatches.length; i++) {
    var toolName = toolMatches[i].match(/\[TOOL:\s*([\w-]+)\]/)[1];
    toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
  }

  // Repetition profile of the exec commands: how many DIFFERENT commands were
  // run, and whether one command was executed again and again.
  var execCommands = extractExecCommands(corpus);
  var commandCounts = {};
  for (var ec = 0; ec < execCommands.length; ec++) {
    // Benign watchdog loop (node <file>.js ensure) - never a real repetition.
    if (/node\s+[\w\/\.-]+\.js\s+ensure/.test(execCommands[ec])) continue;
    var rawKey = execCommands[ec];
    var normKey = normalizeCommand(rawKey);
    if (!normKey) continue;
    var bucket = commandCounts[normKey];
    if (!bucket) { bucket = { total: 0, raws: {} }; commandCounts[normKey] = bucket; }
    bucket.total += 1;
    bucket.raws[rawKey] = (bucket.raws[rawKey] || 0) + 1;
  }

  var distinctCommands = Object.keys(commandCounts).length;
  var repeatedCommand = false;
  for (var ck in commandCounts) {
    var group = commandCounts[ck];
    var rawKeys = Object.keys(group.raws);
    var rawMax = 0;
    for (var rk = 0; rk < rawKeys.length; rk++) {
      if (group.raws[rawKeys[rk]] > rawMax) rawMax = group.raws[rawKeys[rk]];
    }
    // The very same command ran again and again.
    if (rawMax >= REPEATED_COMMAND_THRESHOLD) { repeatedCommand = true; break; }
    // The same command with a volatile part varying (a number, a temp id).
    // A normalized group made of many DIFFERENT raw commands is an
    // enumeration (sleep 5 / sleep 10 / sleep 15), not a repetition.
    if (group.total >= REPEATED_COMMAND_THRESHOLD && rawKeys.length <= 2) { repeatedCommand = true; break; }
  }

  Object.keys(toolUsage).forEach(function(tool) {
    if (tool === 'exec') {
      // For exec the meaningful number is how many DIFFERENT commands were
      // run: many distinct commands is a different problem than one command
      // executed over and over.
      if (distinctCommands >= HIGH_DISTINCT_COMMAND_THRESHOLD) {
        signals.push('high_tool_usage:exec');
      }
      return;
    }
    if (toolUsage[tool] >= HIGH_TOOL_USAGE_THRESHOLD) {
      signals.push('high_tool_usage:' + tool);
    }
  });

  // Repeated exec usage: the SAME command executed again and again.
  if (repeatedCommand) {
    signals.push('repeated_tool_usage:exec');
  }
  // --- Signal prioritization ---
  // Remove cosmetic signals when actionable signals exist
  var actionable = signals.filter(function (s) {
    return s !== 'user_missing' && s !== 'memory_missing' && s !== 'session_logs_missing' && s !== 'windows_shell_incompatible';
  });
  // If we have actionable signals, drop the cosmetic ones
  if (actionable.length > 0) {
    signals = actionable;
  }

  // --- De-duplication: suppress signals that have been over-processed ---
  if (history.suppressedSignals.size > 0) {
    var beforeDedup = signals.length;
    signals = signals.filter(function (s) {
      // Normalize signal key for comparison
      var key = s.startsWith('errsig:') ? 'errsig'
        : s.startsWith('recurring_errsig') ? 'recurring_errsig'
        : s.startsWith('user_feature_request:') ? 'user_feature_request'
        : s.startsWith('user_improvement_suggestion:') ? 'user_improvement_suggestion'
        : s;
      return !history.suppressedSignals.has(key);
    });
    if (beforeDedup > 0 && signals.length === 0) {
      // All signals were suppressed = system is stable but stuck in a loop
      // Force innovation
      signals.push('evolution_stagnation_detected');
      signals.push('stable_success_plateau');
    }
  }

  // --- Force innovation after 3+ consecutive repairs ---
  if (history.consecutiveRepairCount >= 3) {
    // Remove repair-only signals (log_error, errsig) and inject innovation signals
    signals = signals.filter(function (s) {
      return s !== 'log_error' && !s.startsWith('errsig:') && !s.startsWith('recurring_errsig');
    });
    if (signals.length === 0) {
      signals.push('repair_loop_detected');
      signals.push('stable_success_plateau');
    }
    // Append a directive signal that the prompt can pick up
    signals.push('force_innovation_after_repair_loop');
  }

  // --- Force innovation after too many empty cycles (zero blast radius) ---
  // If >= 50% of last 8 cycles produced no code changes, the evolver is spinning idle.
  // Strip repair signals and force innovate to break the empty loop.
  if (history.emptyCycleCount >= 4) {
    signals = signals.filter(function (s) {
      return s !== 'log_error' && !s.startsWith('errsig:') && !s.startsWith('recurring_errsig');
    });
    if (!signals.includes('empty_cycle_loop_detected')) signals.push('empty_cycle_loop_detected');
    if (!signals.includes('stable_success_plateau')) signals.push('stable_success_plateau');
  }

  // --- Saturation detection (graceful degradation) ---
  // When consecutive empty cycles pile up at the tail, the evolver has exhausted its
  // innovation space. Instead of spinning idle forever, signal that the system should
  // switch to steady-state maintenance mode with reduced evolution frequency.
  // This directly addresses the Echo-MingXuan failure: Cycle #55 hit "no committable
  // code changes" and load spiked to 1.30 because there was no degradation strategy.
  if (history.consecutiveEmptyCycles >= 5) {
    if (!signals.includes('force_steady_state')) signals.push('force_steady_state');
    if (!signals.includes('evolution_saturation')) signals.push('evolution_saturation');
  } else if (history.consecutiveEmptyCycles >= 3) {
    if (!signals.includes('evolution_saturation')) signals.push('evolution_saturation');
  }

  // --- Failure streak awareness ---
  // When the evolver has failed many consecutive cycles, inject a signal
  // telling the LLM to be more conservative and avoid repeating the same approach.
  if (history.consecutiveFailureCount >= 3) {
    signals.push('consecutive_failure_streak_' + history.consecutiveFailureCount);
    // After 5+ consecutive failures, force a strategy change (don't keep trying the same thing)
    if (history.consecutiveFailureCount >= 5) {
      signals.push('failure_loop_detected');
      // Strip the dominant gene's signals to force a different gene selection
      var topGene = null;
      var topGeneCount = 0;
      var gfEntries = Object.entries(history.geneFreq);
      for (var gfi = 0; gfi < gfEntries.length; gfi++) {
        if (gfEntries[gfi][1] > topGeneCount) {
          topGeneCount = gfEntries[gfi][1];
          topGene = gfEntries[gfi][0];
        }
      }
      if (topGene) {
        signals.push('ban_gene:' + topGene);
      }
    }
  }

  // High failure ratio in recent history (>= 75% failed in last 8 cycles)
  if (history.recentFailureRatio >= 0.75) {
    signals.push('high_failure_ratio');
    signals.push('force_innovation_after_repair_loop');
  }

  // If no signals at all, add a default innovation signal
  if (signals.length === 0) {
    signals.push('stable_success_plateau');
  }

  return Array.from(new Set(signals));
}

module.exports = { extractSignals, hasOpportunitySignal, analyzeRecentHistory, OPPORTUNITY_SIGNALS, stripVolatileRuntimeState, pickErrorSignatureLine, normalizeCommand, extractExecCommands, PERF_INCIDENT_RE };
