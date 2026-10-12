# Mode `red`: the spec's tests first

Write one test per line under Tests (a bug's triage test already exists).
Each title is the spec's claim, word for word where it fits. Run them: each
fails on a named assertion, for the reason the spec gives, not on a typo or
a timeout (testing rule 2). Then:

```bash
git add <test files> && git commit -m "test: <issue title, imperative> (#<N>)"
git push -u origin <kind>/<N>
gh pr create --draft --title "<type>(<scope>): <summary>" --body-file <scratch>/pr-<N>.md
```

The PR body, in this order: `Closes #<N>`; a `### Status` section the
orchestrator keeps current; the Done when lines as an unchecked list;
`## Assumptions` ("none", or one `- Assumption:` line per gap); the line
`*Written by an agent.*`. Keep it current as you go.

Report the `map`: for each red test, the source files it needs changed,
from what you read while writing it.
