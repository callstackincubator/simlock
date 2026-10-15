# Mode `red`: the spec's tests first

Write one test per line under Tests (a bug's triage test already exists),
or extend the existing test the line names (testing rule 7). Each title is
the spec's claim, word for word where it fits. Before you run them, read
each against testing rules 6, 8 and 10: it asserts on the module's output,
not its internals; no log line the user docs do not describe; none of the
shapes that cannot fail. Run them: each
fails on a named assertion, for the reason the spec gives, not on a typo or
a timeout (testing rule 2). Then:

```bash
git add <test files> && git commit -m "test: <issue title, imperative> (#<N>)"
LEFTHOOK_EXCLUDE=fallow git push -u origin <kind>/<N>
gh pr create --draft --base <base, or main> --title "<type>(<scope>): <summary>" --body-file <scratch>/pr-<N>.md
```

The push skips Fallow alone: the placeholders that let the red tests compile
are dead code until green replaces them, and CI's Fallow job reports them
meanwhile. Every other push runs every hook. With a `base` argument (a task
stacked on its feature's last reviewed PR), the PR targets that branch.

The PR body, in this order: `Closes #<N>`; a `### Status` section the
orchestrator keeps current; the Done when lines as an unchecked list;
`## Assumptions` ("none", or one `- Assumption:` line per gap); the line
`*Written by an agent.*`. Keep it current as you go.

Report the `map`: for each red test, the source files it needs changed,
from what you read while writing it.
