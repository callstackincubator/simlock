# Mode `fix`: apply verified findings

Each finding line is a verified defect, names its class in brackets (the
rule it breaks), and ends in `src` (the fix changes production source) or
`text` (a test, a comment, a doc or an assumption line is enough).

1. **Find every instance.** The line is one instance of its class. Search
   the whole diff for others, and for a stale claim have an `Explore` agent
   search the whole repo. For an order, interleaving or conflict between two
   components, list every path through the same code (each caller, flag,
   mode and order, including both at once) and check each.
2. **Fix every instance:**
   - behaviour: write the failing test first, then the fix;
   - stale doc: fix it. Stale comment: delete it, or fix it if the comment
     rule allows it (it starts with `why:`). Each fact in the new text (who
     does it, which cases, which values) names the `path:line` that shows it
     before you commit; a fact you cannot point to stays out. Told to edit
     tests, comments and docs only: a finding that needs any other change
     goes under `open` instead;
   - a line ending in `(record as Assumption: ...)`: also add that
     assumption to the PR body;
   - a slow-lane Evidence line is a failing test: fix the code, not the
     test;
   - a `ci:` line: the named test failed in CI; a line asking to merge the
     base branch: merge it and resolve the conflicts.
3. One commit per finding or closely related group. Then the audit
   (`implement-audit.md`, with the sweep) and the test check on every test
   the fix touched or added. Recheck every `Assumption:` line in the PR
   body, not only those this fix touched.
