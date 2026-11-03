# Long file recipe

The procedure this skill implements, written out for an agent that has to do
it by hand -- for example when the file has to be produced through a tool
that cannot run Node.

## 1. Split

Cut the content into parts of at most 120 lines and at most 12000 characters.

Prefer a natural boundary:

1. an empty line;
2. a markdown heading or a section rule;
3. the opening or closing edge of a fenced code block;
4. a point where brace depth has returned to zero (end of a function, class
   or statement).

Never cut inside:

- a fenced code block;
- a string literal or a template literal;
- a block comment.

If no natural boundary exists inside the window, close the part at the line
limit and remember that the cut was a hard cut. The file is still correct:
the parts are concatenated verbatim.

## 2. Write and append

- Part 1: write the file with the first part.
- Part N: append the file with a newline followed by part N.

The newline in front of every appended part is what makes the parts join
exactly: part 1, newline, part 2, newline, part 3 is the original content.

Never send the whole file in one call. Never send an append whose payload
exceeds the reply cap.

## 3. Read back and verify

Read the file back from disk, paged, and check:

- the content equals the intended content byte for byte;
- the line before and the line after every join are the intended ones;
- braces, brackets and parentheses are balanced and no string or comment is
  left open;
- no block of the same line is repeated.

Only then run or execute the file.

## 4. Recovery when a call was cut off

**Never retry the oversized call.** It will be cut off in the same place.

1. Look at what actually landed on disk.
2. Find the largest prefix of parts that matches the file exactly. That is
   the last successfully written boundary.
3. Re-split the remaining content into parts of at most 120 lines.
4. Append the remaining parts, one call per part.
5. Read the file back and verify again.

The skill does this for you:

```js
var report = writer.writeLongFile('docs/guide.md', content, { resume: true });
report.resumed;          // true
report.resumedFromPart;  // the first part that still has to be written
```

If the file on disk matches no part boundary at all, it is not a prefix of
the intended content: do not append to it. Start over from part 1 with a
clean write, or restore the previous version.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `content_mismatch_at_offset:N` | a part was truncated or appended twice | re-split and resume from the last good boundary |
| `seam_mismatch_at_part:N` | the append did not start where the previous part stopped | append a newline plus the part, not the part alone |
| `delimiters_unbalanced` | the file was cut in the middle of a block | the cut was a hard cut: re-split on a natural boundary |
| `existing-file-does-not-match-any-boundary` | the file on disk is not a prefix of the intended content | start over with a clean write |
| non-empty `undefinedReferences` | a name is called but never defined | check the seam where the definition should have been |
