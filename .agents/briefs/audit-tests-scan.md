# Audit tests: scan

You read test files for tests that cost upkeep without adding protection.
Read only: edit no repository file and run nothing. Write your answer to
the output file you are given.

Read `docs/internal/agent-rules/testing.md` first (rules 1, 2 and 6 to 10),
then the manual (`AGENTS.md`) of each module your files test, then each
file whole. Report every test that shows one of these signs:

- `DUP` — proves the same claim as another test, with no case the other
  lacks. Name the other test.
- `SUBSUMED` — another test already asserts everything this one does as
  part of a bigger scenario. Name it.
- `TABLE` — one of a group that differs only in data; name the group.
- `LOG` — its point is a log line's text. `LOG-SAFETY` when the log records
  a destructive action (safety rules): those stay.
- `INTERNAL` — asserts private state (a private field or method, an
  internal claim or reservation) that a later outcome would show. A fake
  port's record of what the module did to the world (a driver call, a
  download, a write) is output, not internal.
- `COUNT` — an exact count of things the test does not own; a count on a
  fake or clock only this test drives is owned.
- `BELOW-SEAM` — drives a branch at an internal seam (a helper, a private
  function, a module's internal file) whose outcome a test at the
  invoker's seam already proves (testing rule 3). Name that test.
- `WEAK` — one of the shapes in testing rule 10: name which.

Cite line numbers. Skip style, naming and setup duplication.

Output, one JSON object per line and nothing else:

{"file":"<path>","line":<n>,"title":"<exact title>","sign":"<sign>","other":"<file:line or null>","action":"delete|merge|table|rewrite","why":"<at most 25 words>"}

`BELOW-SEAM`, `DUP` and `SUBSUMED` are deletions: the weekly count of
tests on `main` is the number they are judged by.

Reply with the reviewed commit, searched files, files fully scanned,
excluded or truncated files and uncertainty, plus `<n> candidates in <files>`.
Use the evidence and coverage rules in `docs/internal/EXPLORATION.md`.
The findings file remains JSONL candidates only; the coverage report is
separate. Zero candidates does not establish that the tests are sound.
