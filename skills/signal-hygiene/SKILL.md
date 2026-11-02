---
name: signal-hygiene
description: Sanitize Hub-derived evolution signals so prose and tool-output fragments never enter the GEP cycle. Use when wiring task titles or task signals into the evolution loop.
---

# signal-hygiene

Decides which raw tokens are real evolution signals, and rewrites near-synonyms
onto their canonical names.

## The problem it solves

Hub tasks arrive with a free-form `signals` string and a free-form `title`.
`src/gep/taskReceiver.js` used to copy both verbatim into the evolution cycle,
so fragments like `self-wait`, `**toolresult**:` and `detected:` became
first-class signals:

- no gene declares `signals_match` for them, so they matched no gene;
- the de-duplication filter in `src/gep/signals.js` only suppresses a signal
  seen 3+ times in the last 8 events, so they survived;
- they kept the stagnation / plateau detectors firing, forcing the cycle into
  another INNOVATE round with no real work to do;
- they were printed into the GEP prompt as if they were requirements.

Sanitizing at the task boundary fixes all four at once: the cycle only ever
sees signals this repository actually knows how to act on.

## Usage

```js
var hygiene = require('../../skills/signal-hygiene');

hygiene.sanitizeSignals(['self-wait', '**toolresult**:', 'detected:',
                         'bottleneck', 'performance', 'external_task']);
// -> ['perf_bottleneck', 'external_task']

hygiene.isKnownSignal('perf_bottleneck');   // true
hygiene.isKnownSignal('self-wait');         // false
hygiene.resolveSignal('bottleneck');        // 'perf_bottleneck'
hygiene.resolveSignal('self-wait');         // null
```

### `sanitizeSignals(tokens, opts) -> string[]`

Applies these rules in order:

1. lowercase and trim every token;
2. keep tokens that belong to a known detail-suffixed family
   (`errsig:`, `recurring_errsig`, `user_feature_request:`, ...) verbatim;
3. rewrite aliases (`performance`, `bottleneck`, `feature`, ...) onto their
   canonical signal;
4. keep tokens that are canonical signal names;
5. drop tokens containing `**`, `[`, `]`, whitespace, a colon outside a
   known prefix, or that are pure punctuation / digits;
6. drop every other unknown fragment (prose) unless `opts.allowUnknown === true`;
7. de-duplicate, preserving first-seen order.

`opts.allowUnknown === true` keeps unknown *bare* tokens (tokens that pass
rule 5). It does not resurrect markup wrappers, colon fragments or numbers.

### `isKnownSignal(token) -> boolean`

True for canonical names, their detail-suffixed families and the numbered
failure-streak names. Aliases are not known signals on their own -- they are
near-synonyms that still need rewriting, so use `resolveSignal()` for those.

### `resolveSignal(token) -> string|null`

Maps a token onto its canonical signal. Returns the token itself for known
families (`errsig:boom`), the canonical name for aliases (`bottleneck` ->
`perf_bottleneck`), and `null` for anything that is not a signal.

## Exports

- `KNOWN_SIGNALS` -- canonical signal names. Every entry is a name this
  repository already emits or matches on (`src/gep/signals.js`,
  `src/gep/mutation.js`, `src/gep/taskReceiver.js`).
- `KNOWN_SIGNAL_PATTERNS` -- canonical names with a numeric suffix
  (`consecutive_failure_streak_3`).
- `PREFIXED_SIGNAL_PREFIXES` -- legitimate detail-suffixed families.
  Tokens starting with one of these are kept untouched.
- `ALIAS_MAP` -- near-synonym to canonical signal.
- `sanitizeSignals(tokens, opts)`
- `isKnownSignal(token)`
- `resolveSignal(token)`
- `normalizeToken(token)`

## Wiring (already done, keep it that way)

`src/gep/taskReceiver.js` requires the skill and routes BOTH the
`task.signals` fragments and the `task.title` word extraction through
`sanitizeSignals()` before they enter the evolution cycle:

```js
var hygiene = require('../../skills/signal-hygiene');
```

`external_task` and `bounty_task` are added by `taskToSignals()` itself and
are canonical signals -- keep pushing them directly.

Any new signal name that this repository starts emitting must be added to
`KNOWN_SIGNALS` (or `KNOWN_SIGNAL_PATTERNS`); otherwise the sanitizer will
drop it and the cycle will never see it.

## Self-test

```bash
node skills/signal-hygiene/scripts/selftest.js
```

Exits 0 when every rule holds.
