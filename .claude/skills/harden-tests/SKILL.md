---
name: harden-tests
description: Weekly routine — mutation-test the newest source lines main changed since the last run, kill with tests only the survivors that change what a caller or user can see, and land one tests-only PR through the reviews and the merge gate. Use when a Claude Code routine or the user says "harden tests".
model: sonnet
effort: medium
---

# Harden tests

Rules: `docs/internal/agent-rules/testing.md`, `toolchain.md`, and
`delivery.md` rules 14 and 15. You are the author of this PR: there is no
issue and no implementer.

## 1. Workspace and base

```bash
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow
git fetch -q origin
dir=$(.agents/scripts/worktree.sh chore/harden-tests-$(date +%F)) && cd "$dir"
base=$(git log -1 --format=%H --grep='^test(harden):' origin/main)
[ -n "$base" ] || base=$(git rev-list -1 --before='7 days ago' origin/main)
pnpm mutate "$base" --max-lines 1500 > <scratch>/mutate.txt 2>&1; echo "exit $?"
```

The line budget keeps the run under ~15 minutes, inside the cloud's
30-minute limit on background commands; the files it skips are not tested
this run.

Exit 0, or "nothing to mutate": report `PR: none` and stop. Exit 2: report
the error lines it printed and stop.

## 2. Triage every survivor first

Sort each line `mutate.txt` lists as alive into one bucket, from reading the
code it changes and who reads its result:

- **kill**: it changes what a caller, a user, a stored record or an event
  sees;
- **equivalent**: it changes nothing observable;
- **low value**: it changes only a detail nothing depends on (a log line's
  wording or module name, a guard on a value that is never missing);
- **dead code**: the line can go with a green suite.

Only `kill` gets a test. Never edit source code in this PR. Dead code goes
in one `bug:new` issue listing each line and why, linked from the PR body.

## 3. Kill

Split the `kill` list by count, at most 25 mutants per helper, all of one
source file's mutants with one helper, and no two helpers on the same test
file. Start them in one message, each an Agent call with
`run_in_background: false` and `subagent_type: "general-purpose"`, with:
the worktree, its mutant lines, the test files it owns, and this brief:

```markdown
For each mutant: tighten the test in the files you own that already
proves the behaviour next to it (a case, an assertion), or write one only
when none does; its title states the behaviour the mutant breaks (testing
rules 1, 2 and 7). Apply
the mutant by hand, run the test file with
`pnpm exec vitest run --project unit <file>`, see it fail on the assertion
the title names, then restore the source. Edit no source file. Answer one
line per mutant and nothing else:
`<file>:<line> killed by <test file>: "<title>"` or
`<file>:<line> not killed: <why, at most 15 words>`.
```

Run each changed test file once more, then:

```bash
git add -A && git commit -m "test(harden): kill the mutants main's changes left alive since <short base>"
git push -u origin HEAD
gh api -X POST repos/<owner>/<repo>/pulls -f title="test(harden): kill the mutants main's changes left alive since <short base>" \
  -f head="$(git branch --show-current)" -f base=main -F draft=true -F body=@<scratch>/pr.md -q .number
```

The body: `<base>..<head>`, the mutant and survivor counts, the number of
files `mutate.txt` says it skipped, then one line
per survivor under Killed, Equivalent, Low value and Not killed, each with
its reason, the dead-code issue's link, and `*Written by an agent.*`.

## 4. Review and merge

`reviewer` with the PR number, round 1. Fix each Fix line yourself, tests
only, then the check its Rerun names, as rule 14 says: `reviewer` with
that name, `previous <Commit>` and the complete resolution ledger. `Rerun: none` with
findings open: leave the PR in draft and report them.

Add the `## Review` section exactly as the deliver skill's step 4 shapes it,
with `Spec review: skipped.` (edit the body with
`gh api -X PATCH repos/<owner>/<repo>/pulls/<M> -F body=@<file>`; `gh pr edit`
is GraphQL, which a cloud session refuses). Then `gh pr ready <M>` (in a cloud session it
fails with a 403 naming the proxy's ready-for-review route: call that route)
and `.agents/scripts/merge-pr.sh <M>`. Red CI from a test this PR changed: fix
it once, run the applicable targeted fix-check, then the gate again. Anything else: leave the PR open and report.

## Report

```
Routine: harden-tests  Base: <short sha>  Alive: <n> (kill <k>, equivalent <e>, low value <l>, dead <d>)
PR: #M merged | #M open (<why>) | none
```

Review follow-up uses `docs/internal/REVIEW.md`: pass the previous SHA and
resolution ledger, classify actual impacts and recheck changed assertions
with code/tests and changed claims with claims. Record all invocations and
Assessment. The round cap parks unresolved blocking or incomplete work;
tests/comments are not blanket exemptions from recheck.
