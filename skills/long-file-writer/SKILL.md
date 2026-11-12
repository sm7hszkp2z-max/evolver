---
name: long-file-writer
description: Write long files in verifiable segments. Splits content at natural boundaries into parts of at most ~120 lines, writes the first part, appends the rest so every part continues exactly where the previous one stopped, then reads the file back from disk and verifies every seam. Detects a tool result that was cut off by the reply cap and produces the ordered continuation, and locates a broken seam and emits the minimal corrective payload. Use when creating or editing a file longer than ~120 lines, when a write risks being cut off by the reply cap, when a previous oversized write came back truncated, or when a read-back shows duplicated or missing lines.
---

# long-file-writer

Long files get truncated. A single write call that exceeds the reply cap is
cut off mid-statement, the tool may still look successful, and the natural
reaction -- retrying the same oversized call -- is cut off in exactly the
same place.

This skill turns that loop into a four-step procedure with a real
verification pass:

1. **Split** the content at natural boundaries into parts of at most ~120 lines.
2. **Write** part 1, then **append** every following part so that it starts
   exactly where the previous one stopped.
3. **Read back** the whole file from disk and verify every seam: nothing
   duplicated, nothing missing, delimiters balanced.
4. **Only then** run or execute the file.

## Safety boundary

> **Never retry an oversized call that was cut off by the reply cap.**
> Re-split the content and resume from the last successfully written
> boundary instead.

The rule is enforced by the API (`writeLongFile(..., { resume: true })` finds
the last successfully written boundary and continues there) and spelled out
step by step in `references/recipe.md`.

## Usage

### As a command

```bash
# write a long file in segments and verify it
node skills/long-file-writer/scripts/write-long-file.js \
  --out docs/guide.md --in docs/guide.src.md

# inspect the plan without touching the filesystem
node skills/long-file-writer/scripts/write-long-file.js \
  --out docs/guide.md --in docs/guide.src.md --dry-run

# continue a file whose write was cut off
node skills/long-file-writer/scripts/write-long-file.js \
  --out docs/guide.md --in docs/guide.src.md --resume

# preserve an existing target unless every segment and verification succeeds
node skills/long-file-writer/scripts/write-long-file.js \
  --out docs/guide.md --in docs/guide.src.md --atomic
```

The command prints a JSON report and exits non-zero when the verification
fails.

### As a library

```js
var writer = require('./skills/long-file-writer');

// 1. split only -- pure, no side effects
var parts = writer.splitIntoParts(content);              // at most 120 lines each
parts.map(function (p) { return p.text; }).join('\n') === content;   // true

// 2. write, append, read back, verify
var report = writer.writeLongFile('docs/guide.md', content);
report.ok;                       // true when every check passed
report.verification.exactMatch;  // the file on disk equals the content
report.verification.seams;       // one entry per join, each with .ok
report.verification.delimiters;  // { balanced: true, problems: [] }
```

### The calls that matter

| Call | What it does |
|---|---|
| `splitIntoParts(text, opts)` | Pure splitter. Parts of at most `maxLines` (default 120) lines and `maxChars` (default 12000) characters. |
| `planParts(text, opts)` | The same parts as plain strings, ready to be sent as separate tool calls. |
| `planWrite(path, text, opts)` | The exact payloads: `write` for part 1, `append` for the rest. |
| `writeLongFile(path, content, opts)` | Write, append, read back, verify. Returns a report. |
| `verifyReadBack(path, content, opts)` | The verification pass on its own. |
| `resumeBoundary(path, parts)` | Finds the last successfully written boundary of a partial file. |
| `escapeTemplateLiteral(text)` | Escapes the backslash, the backtick and `${` so text can live inside a JS template literal. |
| `planExecAppend(path, text, opts)` | Exec-ready payloads: segment 1 for the `write` tool, the rest as base64 python one-liners. |
| `scanTemplateLiterals(code, opts)` | Guard: reports template literals that are too big, carry an unescaped backtick or `${`, or were never closed. |
| `detectReplyCapCutoff(text)` | Recognises a tool result that reports a truncated call. Returns `{ cutoff, reason, confidence }`; a successful result returns `cutoff:false`. |
| `planResumeAfterCutoff(path, content, toolResultText, opts)` | The ordered continuation after a cutoff: re-splits into parts of at most ~120 lines and resumes from the last successfully written boundary. |
| `planSeamRepair(path, content, opts)` | Locates the first offending seam (duplicated lines, missing span, unbalanced delimiters) and emits the minimal corrective payload plus the verification step. |

## Natural boundaries

The splitter cuts where the text is structurally complete:

| Boundary | Where it is |
|---|---|
| `blank-line` | after an empty line |
| `heading` | after a markdown heading |
| `section-rule` | after a horizontal rule |
| `fence-open` / `fence-close` | at the edge of a fenced code block |
| `code-block-end` | where brace depth returns to zero |

It never cuts inside a fenced code block, inside a string literal or inside a
block comment. When no boundary is reachable inside the window, the part is
closed at the line limit and the reason is recorded as `hard-limit`; the
concatenation stays exact, so the file is never damaged.

## What the verification proves

`verifyReadBack` re-reads the file from disk in pages (explicit byte offsets)
and checks:

- **exact equality** with the intended content, which catches a missing or a
  duplicated line at any offset;
- **every seam**: the line before and the line after each join is the
  intended one;
- **balanced delimiters**: braces, brackets and parentheses still match and
  no string or comment is left open (prose that merely contains a stray
  bracket is reported but does not fail the check);
- **duplicates**: a repeated block of the same line is flagged;
- **referenced names**: names that are called but never defined are listed
  (advisory only).

## Options

| Option | Default | Meaning |
|---|---|---|
| `maxLines` | `120` | Hard line limit per part. |
| `maxChars` | `12000` | Hard character limit per part. |
| `minLines` | `30` | A natural boundary closer than this is ignored in favour of a bigger part. |
| `resume` | `false` | Continue from the last successfully written boundary instead of starting over. |
| `atomic` | `false` | Write and verify a sibling temporary file, then rename it over the target; cannot be combined with `resume`. |
| `verify` | `true` | Run the read-back verification. |
| `onPart` | -- | Callback fired after each part is written; use it to drive one tool call per part. |

## Code-mode exec path

In OpenClaw code mode a payload is embedded in a JavaScript cell, and it
breaks there in two ways:

- an unescaped backtick or `${` inside a template literal ends the literal
  early -> `SyntaxError ... Unexpected token`, and the **whole** cell never
  runs: nothing partial happens, so there is nothing to resume;
- a payload larger than the reply cap is truncated mid-statement.

Three helpers close that gap.

| Call | What it does |
|---|---|
| `escapeTemplateLiteral(text)` | Escapes the backslash, the backtick and `${` so arbitrary text can live inside a JS template literal. Round-trip safe. |
| `unescapeTemplateLiteral(text)` | The inverse of the above. |
| `isTemplateSafe(text)` | True when the text can be dropped into a template literal unchanged. |
| `planExecAppend(path, text, opts)` | The ordered, exec-ready payloads: segment 1 for the `write` tool, segments 2..n as base64 python one-liners that are passed through the shell unchanged. |
| `scanTemplateLiterals(code, opts)` | The guard: finds the template literals in a code cell and reports the ones that are too big, that carry an unescaped backtick or a `${` interpolation, or that were never closed. |

### The recipe

```js
var writer = require('./skills/long-file-writer');

// 1. guard first: catch the payload before it breaks the cell
var guard = writer.scanTemplateLiterals(codeCell);
if (!guard.ok) throw new Error(guard.summary);

// 2. plan the write: segment 1 -> write tool, segments 2..n -> exec
var plan = writer.planExecAppend('docs/guide.md', content);
await write({ path: 'docs/guide.md', content: plan.segments[0].json });
for (var i = 1; i < plan.segments.length; i++) {
  await exec({ command: plan.segments[i].payload });
}
```

Every append payload is a complete shell command:

```
python3 -c 'import base64,sys;open(sys.argv[1],"ab").write(base64.b64decode(sys.argv[2]))' <path> <base64>
```

The base64 is the point: the chunk travels through the shell unchanged, so
the command holds no backtick, no dollar sign and no backslash and can be
embedded in a JavaScript template literal as it is. Segment 1 offers the
same content three ways: `payload` (raw), `json` (a JS string literal) and
`escaped` (a template-literal-safe body).

`planWrite(path, text, { transport: 'exec' })` returns the same payloads
through the usual planning interface.

## When a call comes back cut off

The Hub gene asset
`sha256:81500e6e810a0c8dcbec5fc14cfe956c0ac7f86fc4fcd609db561e892fb5a21e`
names two anti-patterns. Both have a repair step, and both repairs are
helpers here:

| Hub asset | OpenClaw | Repair helper |
|---|---|---|
| `write_file` | the `write` tool (part 1) | -- |
| `append_file` | the `exec` append (base64 python one-liner) | -- |
| `read_file` | the `read` tool / `readFilePaged` | -- |
| `tool_result_says_the_call_was_cut_off_by_the_reply_cap` | -- | `detectReplyCapCutoff` + `planResumeAfterCutoff` |
| `read_back_shows_duplicated_lines_missing_text_unbalanced_brackets_tags_or_names` | -- | `planSeamRepair` |

```js
// 1. the tool result says the call was cut off -- do NOT retry it
var cut = writer.detectReplyCapCutoff(toolResultText);
// cut.cutoff === true, cut.reason === 'cutoff-phrase:reply-cap'

// 2. ask for the ordered continuation from the last good boundary
var plan = writer.planResumeAfterCutoff('docs/guide.md', content, toolResultText);
plan.strategy;        // 'resume-at-part-boundary' | 'write-from-start' | 'rewrite-prefix-and-append'
plan.resumedFromPart; // the first part that still has to be written
plan.calls;           // ordered tool calls: append and exec, never a retry of the oversized call

// 3. when the read-back shows a broken seam, ask for the corrective payload
var repair = writer.planSeamRepair('docs/guide.md', content);
repair.problem.kind;  // 'duplicate-lines' | 'missing-span' | 'extra-content' | 'unbalanced-delimiters'
repair.repair.kind;   // 'append-missing-span' | 'rewrite-prefix-and-append' | 'none'
repair.calls;         // rewrite the good prefix, append only the corrected span
repair.verification;  // the verifyReadBack call to run afterwards
```

The same plans are available from the command line:

```bash
node skills/long-file-writer/scripts/write-long-file.js \
  --out docs/guide.md --in docs/guide.src.md --resume-after-cutoff result.txt

node skills/long-file-writer/scripts/write-long-file.js \
  --out docs/guide.md --in docs/guide.src.md --repair-seam
```

Both print the plan as JSON and touch nothing on disk.

## Files

- `index.js` -- splitter, writer, verifier. Dependency-free, no network.
- `scripts/write-long-file.js` -- command line front end.
- `scripts/selftest.js` -- functional test: split, exact round trip, seam
  check, resume.
- `references/recipe.md` -- the runbook: boundaries, recovery, troubleshooting.

## Test

```bash
node skills/long-file-writer/scripts/selftest.js
# long-file-writer selftest: OK (233 line sample, 2 parts, 1 seams verified)
```
