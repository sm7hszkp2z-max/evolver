---
name: exec-redundancy-auditor
description: Quantify repeated exec usage in a GEP corpus. Turns the boolean repeated_tool_usage:exec signal into numbers -- which command repeats, how often, and how large the redundancy share of the corpus is. Use when the exec-redundancy signal keeps firing, when auditing a transcript or run log for repeated shell commands, or when deciding whether a repeated command deserves its own skill.
---

# exec-redundancy-auditor

`src/gep/signals.js` emits `repeated_tool_usage:exec` as a **boolean**: it
says that *some* command ran more than once, but never says WHICH command or
HOW OFTEN. The signal fired in 3 of the last 8 cycles, and every one of those
cycles re-derived the same vague answer.

This skill turns the boolean into numbers. It reuses the repo's own extractors
(`extractExecCommands`, `normalizeCommand`) instead of re-implementing them,
so the audit can never drift away from the signal logic.

## Corpus format

The auditor reads the command signatures that the transcript scanner emits:

```
[TOOL: exec] [CMD: git status]
```

Everything else in the corpus is ignored. A corpus without any `[CMD: ...]`
marker yields `totalCalls: 0` and an empty `repeated` list -- that is a
valid result, not an error.

## Usage

### As a command

```bash
# report over one or more logs / transcripts
node skills/exec-redundancy-auditor/index.js logs/run-20261119-010244.log

# machine readable output
node skills/exec-redundancy-auditor/index.js logs/*.log --json

# Prometheus exposition
node skills/exec-redundancy-auditor/index.js logs/*.log --metrics

# only commands executed at least 3 times
node skills/exec-redundancy-auditor/index.js logs/*.log --min-count=3
```

### As a library

```js
const auditor = require('./skills/exec-redundancy-auditor');

const result = auditor.auditCorpus(corpusText);
// -> { totalCalls, distinctCommands, repeatedCount, redundancyRatio, repeated }

const merged = auditor.auditFiles(['logs/a.log', 'logs/b.log']);
console.log(auditor.formatReport(merged));
console.log(auditor.collectMetrics(merged, { threshold: 0.3 }));
```

## Exports

### `auditCorpus(text, options) -> object`

Audits one corpus text. Returns:

| field | meaning |
| --- | --- |
| `totalCalls` | number of exec command calls found (benign watchdog calls excluded) |
| `distinctCommands` | number of distinct commands after normalization |
| `repeatedCount` | number of distinct commands executed more than once |
| `redundancyRatio` | `(totalCalls - distinctCommands) / totalCalls`, 4 decimals, `0` for an empty corpus |
| `repeated` | `[{ command, count }]`, commands executed more than once, sorted by count descending |

Options:

- `minCount` (default `2`) -- the repetition threshold. A command is
  "repeated" when it was executed `minCount` times or more.
- `skipBenignWatchdog` (default `true`) -- skip the benign watchdog loop
  `node <file>.js ensure`, the same guard `src/gep/signals.js` applies.

`command` holds the most frequent raw spelling of the group (ties broken
lexicographically), so the report stays human readable; grouping itself uses
`normalizeCommand`, which masks uuids, timestamps, durations and numbers.

### `auditFiles(paths, options) -> object`

Reads every file in `paths` and merges the corpus texts into a single
`auditCorpus` result. Same options as `auditCorpus`.

### `formatReport(result) -> string`

Human readable report:

```
exec-redundancy-auditor report
  exec calls        : 4
  distinct commands : 2
  repeated commands : 1
  redundancy ratio  : 0.5
  repeated          :
    x3  git status
```

### `collectMetrics(result, options) -> string`

Prometheus style text exposition:

- `exec_total_calls` (counter)
- `exec_distinct_commands` (gauge)
- `exec_repeated_commands` (gauge)
- `exec_repeated_calls` (gauge)
- `exec_redundancy_ratio` (gauge)
- `exec_redundancy_alert` (gauge, `1` when the ratio is above
  `options.threshold`, default `0.5`)

### Constants

- `BENIGN_WATCHDOG` -- the watchdog pattern that is skipped.
- `DEFAULT_MIN_COUNT` (2), `DEFAULT_ALERT_THRESHOLD` (0.5).

## Self-test

```bash
node skills/exec-redundancy-auditor/scripts/selftest.js
```

Prints `  ok   <name>` per check and exits non-zero when a check fails.

## Notes

- The skill is read-only: it never writes to the corpus, the log store or the
  asset stores.
- No new npm dependencies. The repo still installs with `dotenv` only.
- The audit is deliberately local. It does not change `src/gep/signals.js`:
  the signal stays a boolean, the audit turns it into a number when a cycle
  asks "which command is repeating?".
