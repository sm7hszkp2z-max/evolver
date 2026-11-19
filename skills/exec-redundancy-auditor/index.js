'use strict';
// exec-redundancy-auditor -- quantify repeated exec usage in a GEP corpus.
//
// src/gep/signals.js emits "repeated_tool_usage:exec" as a BOOLEAN: it says
// that *some* command ran more than once, but never says WHICH command or
// HOW OFTEN. The signal fired in 3 of the last 8 cycles and every one of
// those cycles re-derived the same vague answer.
//
// This skill turns the boolean into numbers: which command repeats, how
// often, and how large the redundancy share of the corpus is.
//
// It reuses the repo's own extractors instead of re-implementing them, so
// the audit can never drift away from the signal logic:
//
//   extractExecCommands(corpus) -> the raw command strings carried by the
//                                  "[TOOL: exec] [CMD: <signature>]" markers
//   normalizeCommand(command)  -> a grouping key with the volatile parts
//                                  (uuids, timestamps, durations, numbers)
//                                  masked
//
// Node built-ins only. No network, no npm dependencies.

const fs = require('fs');

const { extractExecCommands, normalizeCommand } = require('../../src/gep/signals');

// The benign watchdog loop (node <file>.js ensure) is never a real
// repetition -- it is the same guard the signal logic skips.
const BENIGN_WATCHDOG = /node\s+[\w\/\.-]+\.js\s+ensure/;

const DEFAULT_MIN_COUNT = 2;
const DEFAULT_ALERT_THRESHOLD = 0.5;

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Pick the raw spelling that represents a group best: the most frequent
// one, ties broken lexicographically so the output stays deterministic.
function representativeRaw(group) {
  let best = '';
  let bestCount = -1;
  for (const entry of group.raws) {
    const raw = entry[0];
    const count = entry[1];
    if (count > bestCount || (count === bestCount && raw < best)) {
      best = raw;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Audit one corpus text for repeated exec usage.
 *
 * @param {string} text  corpus text carrying "[CMD: ...]" markers
 * @param {{minCount?: number, skipBenignWatchdog?: boolean}} [options]
 * @returns {{totalCalls: number, distinctCommands: number, repeatedCount: number,
 *            redundancyRatio: number, repeated: Array<{command: string, count: number}>}}
 */
function auditCorpus(text, options) {
  const opts = options || {};
  const minCount = Number.isFinite(opts.minCount) && opts.minCount >= 1
    ? Math.floor(opts.minCount)
    : DEFAULT_MIN_COUNT;
  const skipBenign = opts.skipBenignWatchdog !== false;

  const commands = extractExecCommands(String(text || ''));
  const groups = new Map();
  for (const command of commands) {
    if (skipBenign && BENIGN_WATCHDOG.test(command)) continue;
    const key = normalizeCommand(command);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key: key, total: 0, raws: new Map() };
      groups.set(key, group);
    }
    group.total += 1;
    group.raws.set(command, (group.raws.get(command) || 0) + 1);
  }

  const repeated = [];
  let totalCalls = 0;
  for (const group of groups.values()) {
    totalCalls += group.total;
    if (group.total >= minCount) {
      repeated.push({ command: representativeRaw(group), count: group.total });
    }
  }
  repeated.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    if (a.command < b.command) return -1;
    if (a.command > b.command) return 1;
    return 0;
  });

  const distinctCommands = groups.size;
  return {
    totalCalls: totalCalls,
    distinctCommands: distinctCommands,
    repeatedCount: repeated.length,
    redundancyRatio: totalCalls > 0 ? round4((totalCalls - distinctCommands) / totalCalls) : 0,
    repeated: repeated
  };
}

/**
 * Audit several corpus files as one corpus.
 *
 * @param {string[]|string} paths  log/transcript files carrying "[CMD: ...]"
 * @param {object} [options]       same options as auditCorpus
 * @returns {object} an auditCorpus result
 */
function auditFiles(paths, options) {
  const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  const texts = [];
  for (const file of list) {
    texts.push(fs.readFileSync(file, 'utf8'));
  }
  return auditCorpus(texts.join('\n'), options);
}

/**
 * Human readable report.
 *
 * @param {object} result an auditCorpus result
 * @returns {string}
 */
function formatReport(result) {
  const r = result || { totalCalls: 0, distinctCommands: 0, repeatedCount: 0, redundancyRatio: 0, repeated: [] };
  const lines = [];
  lines.push('exec-redundancy-auditor report');
  lines.push('  exec calls        : ' + r.totalCalls);
  lines.push('  distinct commands : ' + r.distinctCommands);
  lines.push('  repeated commands : ' + r.repeatedCount);
  lines.push('  redundancy ratio  : ' + r.redundancyRatio);
  if (!r.repeated || r.repeated.length === 0) {
    lines.push('  repeated          : (none)');
  } else {
    lines.push('  repeated          :');
    for (const item of r.repeated) {
      lines.push('    x' + item.count + '  ' + item.command);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Prometheus style text exposition of an audit result.
 *
 * @param {object} result an auditCorpus result
 * @param {{threshold?: number}} [options] alert threshold for the ratio
 * @returns {string}
 */
function collectMetrics(result, options) {
  const opts = options || {};
  const r = result || { totalCalls: 0, distinctCommands: 0, repeatedCount: 0, redundancyRatio: 0, repeated: [] };
  const threshold = Number.isFinite(opts.threshold) ? Number(opts.threshold) : DEFAULT_ALERT_THRESHOLD;
  const repeatedCalls = (r.repeated || []).reduce(function (sum, item) { return sum + item.count; }, 0);
  return [
    '# HELP exec_total_calls Total number of exec command calls found in the audited corpus.',
    '# TYPE exec_total_calls counter',
    'exec_total_calls ' + r.totalCalls,
    '# HELP exec_distinct_commands Number of distinct (normalized) exec commands in the corpus.',
    '# TYPE exec_distinct_commands gauge',
    'exec_distinct_commands ' + r.distinctCommands,
    '# HELP exec_repeated_commands Number of distinct commands executed more than once.',
    '# TYPE exec_repeated_commands gauge',
    'exec_repeated_commands ' + r.repeatedCount,
    '# HELP exec_repeated_calls Total number of exec calls that belong to a repeated command.',
    '# TYPE exec_repeated_calls gauge',
    'exec_repeated_calls ' + repeatedCalls,
    '# HELP exec_redundancy_ratio Share of exec calls that repeat an already seen command.',
    '# TYPE exec_redundancy_ratio gauge',
    'exec_redundancy_ratio ' + r.redundancyRatio,
    '# HELP exec_redundancy_alert Whether the redundancy ratio exceeds the configured threshold.',
    '# TYPE exec_redundancy_alert gauge',
    'exec_redundancy_alert ' + (r.redundancyRatio > threshold ? 1 : 0)
  ].join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { files: [], json: false, metrics: false, minCount: undefined, threshold: undefined, help: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--metrics') opts.metrics = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.indexOf('--min-count=') === 0) opts.minCount = Number(arg.slice('--min-count='.length));
    else if (arg.indexOf('--threshold=') === 0) opts.threshold = Number(arg.slice('--threshold='.length));
    else opts.files.push(arg);
  }
  return opts;
}

function runCli(argv) {
  const opts = parseArgs(argv || []);
  if (opts.help || opts.files.length === 0) {
    console.log('Usage: node skills/exec-redundancy-auditor/index.js <logfile> [logfile...] [--json] [--metrics] [--min-count=N] [--threshold=N]');
    return opts.help ? 0 : 1;
  }
  let result;
  try {
    result = auditFiles(opts.files, { minCount: opts.minCount });
  } catch (err) {
    console.error('[exec-redundancy-auditor] cannot read corpus: ' + (err && err.message));
    return 1;
  }
  if (opts.metrics) {
    process.stdout.write(collectMetrics(result, { threshold: opts.threshold }));
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(result));
  }
  return 0;
}

module.exports = {
  auditCorpus: auditCorpus,
  auditFiles: auditFiles,
  formatReport: formatReport,
  collectMetrics: collectMetrics,
  BENIGN_WATCHDOG: BENIGN_WATCHDOG,
  DEFAULT_MIN_COUNT: DEFAULT_MIN_COUNT,
  DEFAULT_ALERT_THRESHOLD: DEFAULT_ALERT_THRESHOLD
};

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
