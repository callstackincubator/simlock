---
name: review
description: Run the two blind pre-merge reviews from delivery rule 14 on a PR or branch — a spec review blind to the rules and a code review blind to the issue, each by a fresh sub-agent — verify every finding, and hand back a fixed report block. Does not edit code. Use when the user says "review #N", "review this branch", "review PR N", or when the deliver orchestrator delegates review.
model: opus
effort: high
context: fork
---

# Review a change before it is marked ready

Rule 14 in `docs/internal/agent-rules/delivery.md` governs this skill: two
reviews, each blind to the other and to the implementer; every finding
verified and either confirmed or rejected with a reason; two rounds at most.
You do not edit code. You find, verify, and report; the implementer fixes.

Arguments: a PR number, optionally `round 2` and which review to re-run
(`spec`, `code`, or `both`). With a branch instead of a PR, the issue is the
second segment of its `<kind>/<n>` name. If the PR is not a delivery PR (a
person's PR the maintainer asked about), post the confirmed findings as one
comment at the end (step 6) and push nothing.

## 1. Gather the inputs

Every input goes into a directory the reviewers read from, so what they see
is exactly what you put there and nothing else.

```bash
git fetch origin main
R=$(mktemp -d)
gh pr diff <PR> > "$R/diff.patch"
gh issue view <N> --json body -q .body > "$R/issue.md"
```

For a task, add the parent's body as `$R/feature.md`. Copy every ADR listed
under Decisions and every file listed under Rules in play into `$R/spec/`.
For a bug, add the triage report as `$R/triage.md`; the Simplest fix section
is the agreed approach. Copy all of `docs/internal/agent-rules/` and
`docs/internal/adr/README.md` into `$R/rules/`.

Do not add the PR body, commit messages, or any note from the implementer.
The reviewers must not know what anyone believes the diff does.

**An ADR-only diff** (every changed path is under `docs/internal/adr/`) gets
the spec review alone, with the ADR brief in step 2. It gets no code review.

## 2. Spawn both reviews, in the foreground

Spawn the spec review and the code review in **one message**, as two Agent
calls with `run_in_background: false` and `model: "opus"`. They run in
parallel, and your turn cannot end while they run, so you never hand back
before the findings are in. On `round 2`, spawn only the review named.

**Spec review.** Read-only. It reads `$R/diff.patch`, `$R/issue.md`,
`$R/feature.md`, `$R/triage.md` and `$R/spec/`, and nothing under
`$R/rules/`. Brief, verbatim, with the paths filled in:

```markdown
You are reviewing a diff against a specification. You have not seen the
specification before and you have no other context. Read only the files
named here; do not open the repository and do not run anything.

Specification: <paths>. Diff: <path>.

Answer three questions, and only these:

1. Is every line of Scope and Done when (for a bug: the Simplest fix; for a
   feature: every Completion condition) delivered by the diff? For each
   line, name the hunk that delivers it or say "not delivered".
2. Does the diff do anything the specification did not ask for? Name it.
   This is a note, never blocking, unless it changes behaviour a user sees.
3. For every test the diff adds or changes: does the title state a claim
   the specification made, and does the body assert that claim? A title
   that promises more than the body proves is a defect.

A finding counts only with a concrete failure (this input or state gives
this wrong result) or a named cost and who pays it. Drop style, naming and
"could be simpler" with no defect.

Report one finding per defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Evidence: `<file>:<line>`.

Do not suggest fixes. Do not praise. If there are no findings, say
"No findings." and stop.
```

For an ADR-only diff, replace questions 1 to 3 with: does the record decide
every question the specification leaves to a decision; does it contradict
an accepted ADR or the specification; is any consequence it states false.
Do not judge it against Completion conditions: an accepted ADR is a target
the code has not reached yet.

**Code review.** In its own detached worktree of the PR head, so it can run
and break things without touching anyone else's checkout:

```bash
W="$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/worktrees/review-<PR>"
git fetch origin <branch> && git worktree add --detach "$W" origin/<branch>
.agents/scripts/worktree.sh --prepare "$W"     # node_modules in seconds, pinned pnpm
```

The reviewer reads `$R/diff.patch` and `$R/rules/`, and nothing else under
`$R`. Brief, verbatim:

```markdown
You are reviewing a diff for correctness and for conformance to the rules
of this repository. You have no other context and you have not seen the
issue this diff implements; judge the code, not the intent.

Rules: <path to $R/rules/>. Diff: <path>. Repository: <worktree path>,
checked out at the reviewed commit. You may run `pnpm check`, `pnpm test`,
`pnpm mutate`, and any command that helps you answer; you may edit code to
see what the suite catches, as long as `git checkout .` restores it before
you report.

Answer two questions, in this order:

1. For every function the diff adds or changes: what input, state, error
   path, or interleaving makes it return the wrong thing or leave the
   wrong state? Where a test exists for it, break the code it covers and
   run the test; if the test stays green, that is a finding. Where you
   suspect a changed path is unreached by any test, delete it and run the
   suite; if nothing goes red, that is a finding.
2. Does the diff break any rule in the rules directory? Cite the file and
   the rule number.

A finding counts only with a concrete failure (this input or state gives
this wrong result) or a named cost and who pays it. Drop style, naming and
"could be simpler" with no defect.

Report one finding per defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Evidence: `<file>:<line>`, or a
  fenced block with the command you ran and its output.

Do not suggest fixes. Do not praise. If there are no findings, say
"No findings." and stop.
```

Remove the code review's worktree when it is done:
`git worktree remove --force "$W"`.

## 3. Verify every finding

A finding is a claim, not a fact. For each one, reproduce its evidence
yourself: read the cited lines, or run the cited command. Then decide:

- **Confirmed**: it goes under Fix in the report, as `path:line what is
wrong`, written so it makes sense without the PR open.
- **Rejected**: one line, `<claim> — <why it is wrong>`.

Two findings that disagree with each other, one from each review, usually
mean the spec is missing a line. Resolve it in favour of the rules, reject
the other with that reason, and add the missing line under Spec needs.

## 4. Decide what runs again

A confirmed finding changes the diff, so the review that raised it runs
again on the next round. After round 2 there is no third: a blocking
finding still confirmed is reported as open, and the orchestrator parks the
issue.

## 5. Report

End with exactly this block, nothing after it:

```
PR: #M  Round: 1 | 2  Kind: code | adr-only
Spec review: n findings (b blocking)  Code review: n findings (b blocking) | skipped
Fix: <one confirmed finding per line, blocking first, as `path:line what is wrong`, or "none">
Rejected: <one per line, `claim — reason`, or "none">
Spec needs: <the line the spec is missing, or "none">
Rerun: spec | code | both | none
```

The orchestrator pastes the Fix lines into the implementer's task and the
Rejected lines into the PR's `## Review` section, so both must stand alone.

## 6. A PR that is not a delivery PR

Post the same findings as one comment, confirmed ones under "Confirmed:"
and rejected ones under "Rejected:", ending with `*Written by an agent.*`.
Rule 12 applies: one line per finding, no narration.
