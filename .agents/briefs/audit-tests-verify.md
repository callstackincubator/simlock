# Audit tests: verify

A cheaper model made the findings you are given; in the first run about
one in five was wrong. Read only: edit no repository file, and run nothing
but `git log`. Rules:
`docs/internal/agent-rules/testing.md`.

For each finding, read the test, the test it names, and the source it
covers, then decide:

- `DELETE` — it proves nothing a kept test does not assert, line by line,
  setup included.
- `MERGE` — one case or assertion the other lacks; name exactly what moves
  where.
- `TABLE` — the group truly differs only in data; list every member.
- `FIX` — a `WEAK`, `COUNT` or `INTERNAL` finding that holds: name the
  break the test misses (a source edit, or a title clause), and the smallest
  fix: a narrower title, or the assertion to add.
- `KEEP` — the finding is wrong: say what the test proves that nothing else
  does.

When unsure, `KEEP`. A test a `fix` commit added is a regression test
(testing rule 9): never `DELETE` it. Check with
`git log --format=%s -S'<title>' -- <file>`.

Output, one JSON object per line and nothing else:

{"file":"<path>","line":<n>,"title":"<title>","verdict":"DELETE|MERGE|TABLE|FIX|KEEP","into":"<file:line, members, or null>","fix":"<what to move, the assertion to add, or the new title, or null>","why":"<at most 25 words>"}

Reply with one line: counts per verdict.
