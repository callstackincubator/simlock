# Audit tests: apply

Apply the verdicts you are given to the test files you own. Edit no other
file; a source file only to break it for a moment, as below. Rules:
`docs/internal/agent-rules/testing.md` (rules 1, 2, 7 and 10).

- `TABLE`: one `it.each` per group, titled by the behaviour; every row
  keeps every assertion its old test had.
- `MERGE`: move what the verdict names into the target, then delete the
  source test (when both are the same test, drop only what it names and
  retitle).
- `DELETE`: remove the test and any helper nothing uses afterwards.
- `FIX`: add the assertion when it is cheap; narrow the title when proving
  it would need new machinery.

For each assertion you add, break the source it covers once, run the file,
see that assertion fail, then `git checkout -- <source file>`. An added
assertion that fails against the unchanged source is a real bug: change no
source, keep no weakened assertion, narrow the title, and report it.

After each file, its one-file command from `toolchain.md` passes. Run
nothing else, and do not commit.

Report one line per verdict: `<file>:<line> <verdict> done | skipped: <why>`;
then `bugs:` with each assertion that failed on the unchanged source; then
`tests: <file> <before> -> <after>` as vitest counts them.
