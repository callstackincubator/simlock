---
name: implement
description: Implement one claimed issue (task, bug, or single-PR feature) tests-first — commit the spec's tests red, open a draft PR, turn them green in checkpoint commits, run pnpm check and pnpm mutate, closing small spec gaps as Assumption lines in the PR body — or apply a list of review or hardware findings to its branch. Ends with a fixed report block. Use when the deliver orchestrator delegates implementation, or when the user says "implement #N".
model: sonnet
effort: medium
context: fork
---

# Implement an issue

Rules 3, 7, 9 and 13 in `docs/internal/agent-rules/delivery.md`, all of
`docs/internal/agent-rules/testing.md`, and
`docs/internal/agent-rules/always-in-scope.md` govern this skill. The issue
body is the spec. You build exactly what it says, plus what
`always-in-scope.md` lists; you do not claim, review, mark ready, or merge —
the orchestrator does those.

Arguments: the issue number, its branch (`<kind>/<N>`), the PR number once
there is one, and the mode: `build`, or `fix` followed by finding lines to
address. Anything else the orchestrator pasted is context.

## 1. Workspace

```bash
dir=$(.agents/scripts/worktree.sh <kind>/<N>)    # resumes origin/<kind>/<N> if it exists
cd "$dir"
```

If the worktree already exists (`git worktree list`), use it. For a bug
whose branch does not exist yet, start from the reproduction instead:
`.agents/scripts/worktree.sh <kind>/<N> origin/bug/<N>-repro`. A branch
that already has commits: read `git log origin/main..` and the PR body's
`### Status` lines, and continue from there.

## 2. Read the spec, and only the spec

The issue body; for a task, its parent's body and the ADRs under Decisions;
for a bug, the triage report (its Simplest fix is the agreed approach); the
latest `## Handoff` comment, whose Findings are facts. Never the rest of the
comment thread. Reread the files under Rules in play before touching the
code they cover.

**A small gap is an assumption, not a stop** (rule 3). When the body, the
agent rules, the accepted ADRs and `always-in-scope.md` all leave a small
question open — a wording, an order, a bound the spec implies but does not
number, which existing helper to reuse — take the conservative option: the
smallest change, the one that matches existing behaviour, the one easiest
to undo. Build it, and record it in the PR body's `## Assumptions` section,
one line each:

```markdown
- Assumption: <the question, in a few words> — <what you chose and why it is the conservative option>.
```

An assumption is a visible proposal, not a spec change: the spec review
checks every line, and the maintainer may reject one.

Stop only when building would contradict the body, a rule or an accepted
ADR, or would change behaviour a user sees in a way nobody decided. Then
push what you have and report it under Open as `spec needs: <line>`. Do not
work around it.

## 3. Red tests first (`build` mode)

Write one test per line under Tests (for a bug, the triage test already
exists). Each title is the claim from the spec, word for word where it
fits. Run them; each must fail on a named assertion for the reason the spec
gives, not on a typo or a timeout (testing rule 2). Then:

```bash
git add <test files> && git commit -m "test: <issue title, imperative> (#<N>)"
git push -u origin <kind>/<N>
gh pr create --draft --title "<type>(<scope>): <summary>" --body-file <scratch>/pr.md
```

The PR body starts with `Closes #<N>`, then a `### Status` section the
orchestrator keeps current, then the Done when lines as an unchecked list,
then `## Assumptions` ("none", or one `- Assumption:` line per gap you
closed), and ends with `*Written by an agent.*`. Keep that section current
as you go, so a resumed run sees it.

## 4. Green in checkpoints

Implement the smallest change that turns the next test green. Each commit
lowers the failing count and says so in its body: `3 failing -> 1 failing`.
Run `pnpm typecheck`, `pnpm lint` and the test files you touched before
each commit; the hooks run the rest (format and lint on commit, `fallow` on
push). Never pass `--no-verify`. Push once per step, not after every commit:
the pre-push hook audits the whole branch.

Build what `always-in-scope.md` lists as you go: both `EVENTS.md` files for
a new or changed event; a search of `README.md`, `docs/` and every
user-facing string (help text, error messages, HTTP error bodies) for claims
your change makes false, fixed in the same branch; a test for every new
path, fallbacks included; a `.fallowrc.json` entry for a new file nothing
imports. Do not widen scope beyond that list: something you notice that is
not in the spec becomes a `bug:new` issue or one line under Open.

## 5. Prove it

**Check your own tests first**, the way the reviewers will. For each test
you added or changed:

- Its title, its assertions and its fixture state make the same claim. A
  title naming two claims has an assertion for each.
- Break the code it covers once (flip the condition, drop the filter, return
  early) and run that test file: it must fail on the assertion its title
  names. Restore the code. A test that stays green is vacuous; fix it now.
- A test that compares two outputs fails when both are wrong in the same
  way: assert one of them against a literal.

If the diff changed a schema, a contract type or a validator, rerun the
tests of every surface that publishes it (MCP `tools/list`, HTTP error
bodies, CLI help) — a refinement can empty a published schema while every
unit test stays green.

Then run the suite once:

```bash
pnpm check     # typecheck, lint, format, unit, fast e2e
pnpm mutate    # mutants on the lines this branch changed
```

`pnpm check` must pass. Run it once per round, after the last change, and
never start a second one while one runs. A failing test you did not touch:
if an open `flaky-test` issue names it (`gh issue list --label flaky-test
--search "<title>"`), list it under Flaky and move on. Otherwise apply
testing rule 5 to that one file: run `pnpm vitest run <file>` in a worktree
of the base commit (`git worktree add <scratch>/base origin/main`), up to
three times. If it fails there, open a `bug:new` issue labelled
`flaky-test` naming the file, the title and the error line, list it, and
move on. If it never fails there, it is yours. Do not stash your work or
re-run the whole suite or the whole e2e project to decide. Never skip,
disable or loosen a test.

Every mutant `pnpm mutate` reports alive is a line you can change or delete
with a green suite. Write the test that kills it, or delete the line if it
does nothing. A mutant that cannot be killed because it changes nothing
observable (an equivalent mutant) goes in the report with the reason.

Note every Done when line that needs a real simulator or emulator; the
orchestrator runs those through the `verify-hardware` skill. Do not run the
slow lane yourself.

## 6. Fix mode

Each finding line is a defect someone verified. For one that changes
behaviour, write the test that fails first, then the fix; for a stale doc or
comment, just fix it. A line ending in `(record as Assumption: ...)` also
adds that assumption to the PR body. A hardware Evidence line is a failing
slow-lane test: fix the code, not the test. One commit per finding or per
closely related group. Then step 5 again, including the self-check on every
test the fix touched: a fix that leaves a test vacuous costs a review round.

## Report

End with exactly this block, nothing after it:

```
Issue: #N  Branch: <kind>/<N>  PR: #M (draft)
Tests: k of n spec tests green (red commit <short sha>)
Check: pass | fail (<what failed>)
Mutate: <n> mutants, <a> alive (<path:line why> per alive mutant, or "none")
Hardware: <Done when lines that need real devices, or "none">
Flaky: <test title — #issue per line, or "none">
Assumptions: <n, as listed in the PR body, or "none">
Open: <"spec needs: ..." lines, blockers, or "none">
```
