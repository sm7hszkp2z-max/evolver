---
name: long-file-writer
description: Write long files in verifiable segments. Splits content at natural boundaries into parts of at most ~120 lines, writes the first part, appends the rest so every part continues exactly where the previous one stopped, then reads the file back from disk and verifies every seam. Use when creating or editing a file longer than ~120 lines, when a write risks being cut off by the reply cap, or when a previous oversized write came back truncated.
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
| `verify` | `true` | Run the read-back verification. |
| `onPart` | -- | Callback fired after each part is written; use it to drive one tool call per part. |

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
