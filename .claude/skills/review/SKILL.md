---
name: review
description: Run the two blind pre-merge reviews from delivery rule 14 on a PR or branch — a spec review blind to the rules and a code review blind to the issue, each by a fresh Opus sub-agent — verify every blocking finding, pass the notes through, and hand back a fixed report block. Does not edit code. Use when the user says "review #N", "review this branch", "review PR N", or when the deliver orchestrator delegates review.
model: sonnet
effort: medium
context: fork
---

# Review a change before it is marked ready

Rule 14 in `docs/internal/agent-rules/delivery.md` governs this skill: two
reviews, each blind to the other and to the implementer; every blocking
finding verified and either confirmed or rejected with a reason; notes
passed on, never verified; two rounds at most. You do not edit code. You
gather the inputs, start the reviewers, verify, and report; the implementer
fixes.

The two reviewers run on Opus (rule 14). This skill only gathers, starts
and verifies, so it runs on Sonnet.

Arguments: a PR number, optionally `round 2` and which review to re-run
(`spec`, `code`, or `both`). With a branch instead of a PR, find its PR
with `gh pr list --head <branch>`. If the PR is not a delivery PR (a
person's PR the maintainer asked about), post the findings as one comment
at the end (step 6) and push nothing.

## 1. Gather the inputs

```bash
R=$(.agents/scripts/review-inputs.sh <PR>)
```

The script builds the directory the reviewers read from and prints its
path last. It holds `diff.patch`; `issue.md`; `feature.md` (a task's
parent); `triage.md` (a bug's triage report, whose Simplest fix is the
agreed approach); `spec/` (the ADRs the spec names, the files under Rules
in play, and always `always-in-scope.md`); `rules/` (every agent rule and
the ADR index); `tests-after-red.patch` (what happened to the spec's tests
after they were committed red); and `assumptions.md` (the PR body's
`Assumption:` lines). A file with nothing to hold is left out, and stderr
names anything the script looked for and could not find. Rules and ADRs come from `main`, so a PR cannot rewrite what it
is judged by.

Add nothing to that directory: not the rest of the PR body, not commit
messages, not a note from the implementer. The reviewers must not know what
anyone believes the diff does.

- **No `issue.md`** (the PR closes no issue): the code review alone; the
  spec review is skipped.
- **An ADR-only diff** (every changed path is under `docs/internal/adr/`;
  `grep '^diff --git' "$R/diff.patch"` shows the paths): the spec review
  alone, with the ADR brief in step 2. No code review.

## 2. Spawn both reviews, in the foreground

Spawn the spec review and the code review in **one message**, as two Agent
calls with `run_in_background: false` and `model: "opus"`. They run in
parallel, and your turn cannot end while they run, so you never hand back
before the findings are in. On `round 2`, spawn only the review named.

**Spec review.** Read-only. It reads every file in `$R` except `rules/`.
Brief, verbatim, with the paths filled in (leave out the sentence for a
file that does not exist):

```markdown
You are reviewing a diff against a specification. You have not seen the
specification before and you have no other context. Read only the files
named here; do not open the repository and do not run anything.

Specification: <issue.md, feature.md, triage.md, spec/>. Diff: <path>.
Tests after red: <path>; it shows every change made to the specification's
tests after they were first committed failing. Assumptions: <path>; each
line is a small gap the specification left open, closed by the implementer.
`spec/always-in-scope.md` lists what every change includes without its
specification asking; treat each item as asked for.

Answer four questions, and only these:

1. Is every line of Scope and Done when (for a bug: the Simplest fix; for a
   feature: every Completion condition) delivered by the diff? For each
   line, name the hunk that delivers it or say "not delivered".
2. Does the diff do anything the specification did not ask for? Name it.
   Anything `always-in-scope.md` lists is asked for: never a finding.
3. For every test the diff adds or changes: does the title state a claim
   the specification made, and does the body assert that claim? A title
   that promises more than the body proves is a defect. In Tests after
   red, for every change that deletes a test or removes or loosens an
   assertion: which line of the specification is no longer proven?
4. For each assumption: is it the conservative choice, and consistent with
   the specification? One that contradicts a line of it, or decides
   behaviour a user would see that nobody decided, is blocking.

Severity. `blocking`: a line not delivered, a test whose title its body
does not prove, a line of the specification left unproven, an assumption
that fails question 4, behaviour a user sees that the specification did
not ask for, or a breach of a file in `spec/`. `note`: anything else worth
one line. Only blocking findings send the change back.

A finding counts only with a concrete failure (this input or state gives
this wrong result) or a named cost and who pays it. Drop style, naming and
"could be simpler" with no defect. Whether the suite passes is not yours
to judge: CI runs it on every push.

Report one finding per defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Evidence: `<file>:<line>`.

Do not suggest fixes. Do not praise. If there are no findings, say
"No findings." and stop.
```

For an ADR-only diff, replace questions 1 to 4 with: does the record decide
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
checked out at the reviewed commit.

Prove a claim with the affected test file only:
`pnpm exec vitest run --project unit <file>` for a unit test, or
`pnpm run build && pnpm run build:e2e && pnpm exec vitest run --project e2e <file>`
for a fast e2e test. Do not run `pnpm check`, `pnpm test`, `pnpm mutate`,
the whole e2e suite, the console lane (`pnpm test:console`) or the slow
lane: CI and the implementer already ran them on this commit.

You may break code to see what a test catches, at most three times in this
review, on your riskiest claims: a changed error path, a bound, a parser,
an interleaving. A probe is one edit to the code under test, one run of its
test file, and `git checkout .`. Read, do not run, everything else. Restore
the tree with `git checkout .` before you report.

Answer two questions, in this order:

1. For every function the diff adds or changes: what input, state, error
   path, or interleaving makes it return the wrong thing or leave the
   wrong state? Where you suspect a test is wired to nothing, break the
   code it covers (one probe) and run its file; if the test stays green,
   that is a finding.
2. Does the diff break any rule in the rules directory? Cite the file and
   the rule number.

Severity. `blocking`: the change breaks behaviour, leaves wrong state, or
breaches a rule or an accepted ADR; a user or a later change pays for it.
`note`: anything else worth one line. When unsure, ask "what breaks, and
for whom?"; no answer means note. Only blocking findings send the change
back.

A finding counts only with a concrete failure (this input or state gives
this wrong result) or a named cost and who pays it. Drop style, naming and
"could be simpler" with no defect.

Report one finding per defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Evidence: `<file>:<line>`, or a
  fenced block with the command you ran and its output.

Do not suggest fixes. Do not praise. If there are no findings, say
"No findings." and stop.
```

Keep the code review's worktree until step 3 is done, then remove it:
`git worktree remove --force "$W"`.

## 3. Verify the blocking findings

A blocking finding is a claim, not a fact. For each one, reproduce its
evidence yourself: read the cited lines, or run the cited command in `$W`,
one test file at a time and never `pnpm check`. Then decide:

- **Confirmed**: it goes under Fix in the report, as `path:line what is
wrong`, written so it makes sense without the PR open.
- **Rejected**: one line, `spec: <claim> — <why it is wrong>` or
  `code: ...`, named for the review that raised it. The weekly delivery
  stats count rejections per review from that tag.
- **True but not blocking**: it breaks no behaviour, leaves no wrong state
  and breaches no rule, ADR or spec line. Reject it with the reason
  `not blocking: <why>`, and list it under Notes as well.

Notes are not reproduced. Pass each one on under Notes, tagged `spec:` or
`code:`, as the reviewer wrote it. A note whose claim is broken behaviour,
wrong state or a rule breach is a mislabelled blocking finding: verify it
as one.

Two findings that disagree with each other, one from each review, usually
mean the spec is missing a line. Resolve it in favour of the rules, reject
the other with that reason, and add the missing line under Spec needs.

**Spec needs** stops delivery for a person, so it is only for a confirmed
finding that cannot be fixed without contradicting the spec, a rule or an
accepted ADR, or whose fix would decide behaviour a user sees that nobody
decided. A fix the spec only leaves open is a Fix line ending in
`(record as Assumption: <the choice>)`. A confirmed blocking finding on an
assumption is a Fix line, unless the assumption decided user-visible
behaviour: then it is Spec needs.

## 4. Decide what runs again

A confirmed blocking finding changes the diff, so the review that raised it
runs again on the next round. Notes never start a round. After round 2
there is no third: a blocking finding still confirmed is reported as open,
and the orchestrator parks the issue.

## 5. Report

End with exactly this block, nothing after it:

```
PR: #M  Round: 1 | 2  Kind: code | adr-only
Spec review: n findings (b blocking) | skipped  Code review: n findings (b blocking) | skipped
Fix: <one confirmed blocking finding per line, as `path:line what is wrong`, or "none">
Notes: <one per line, `spec|code: path:line what could be better`, or "none">
Rejected: <one per line, `spec|code: claim — reason`, or "none">
Spec needs: <the line the spec is missing, or "none">
Rerun: spec | code | both | none
```

The orchestrator pastes the Fix lines into the implementer's task, the
Rejected lines into the PR's `## Review` section, and the Notes lines into
one follow-up comment, so all three must stand alone.

## 6. A PR that is not a delivery PR

Post the findings as one comment: confirmed blocking ones under
"Confirmed:", notes under "Notes (not verified):" and rejected ones under
"Rejected:", ending with `*Written by an agent.*`. Rule 12 applies: one
line per finding, no narration.
