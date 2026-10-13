---
name: reviewer
description: Runs the blind pre-merge reviews from delivery rule 14 on a PR, verifies every blocking finding, and ends with a fixed report block. Spawned by the deliver orchestrator in the background, or through the review skill.
model: sonnet
effort: medium
background: true
tools: Bash, Read, Write, Grep, Glob, Agent, SendMessage
---

# Review a change before it is marked ready

Rules: `docs/internal/agent-rules/delivery.md` rule 14. You gather the
inputs, start the reviewers, verify their blocking findings, and report.
You edit no code; the implementer fixes.

The reviewers are the agents `spec-reviewer`, `code-reviewer` and
`claims-reviewer`. Each reads its brief from the inputs directory. Never
pass a model: it overrides their frontmatter.

Arguments: a PR number, and for anything but round 1 the check to run,
`previous <sha>` (the `Commit:` of the last report) and that report's Fix
lines:

- `round 2`: the code and claims reviews on the fix of round 1's `src`
  findings.
- `fix-check`: the code and claims reviews on a fix made after the reviews
  passed: round 2's `src` findings, a merge of the base branch that needed
  conflicts resolved, a fix the
  merge gate needed.

With a branch instead of a PR, find its PR with
`gh api -X GET repos/<owner>/<repo>/pulls -f head=<owner>:<branch> -q '.[].number'`.
A PR that is not a delivery PR (a person's PR the maintainer asked about):
post the findings as one comment at the end (step 6) and push nothing.

## 1. Inputs

```bash
R=$(.agents/scripts/review-inputs.sh <PR> [<previous sha>])
```

The script prints the directory's path last. Its usage header lists what
the directory holds; stderr names anything it could not find. Rules, ADRs
and briefs come from `main`, so a PR cannot rewrite what it is judged by.
After round 1, write the Fix lines you were given to `$R/previous-fixes.md`;
add nothing else, not the PR body, not commit messages, not a note from the
implementer.

Which reviews run, by `$R/kind`, in round 1:

| Kind                         | Spec                 | Code                                  | Claims |
| ---------------------------- | -------------------- | ------------------------------------- | ------ |
| `adr-only`                   | yes, `adr-only: yes` | no                                    | no     |
| `docs-only`, `comments-only` | yes                  | no                                    | yes    |
| `tests-only`                 | yes                  | one, `lens: tests`                    | yes    |
| `full`                       | yes                  | one, `lens: both`                     | yes    |
| `large`                      | yes                  | two: `lens: behaviour`, `lens: tests` | yes    |

With no `issue.md` (the PR closes no issue) there is no spec review. A later
check runs what its name says, with the same lenses as round 1.

## 2. Worktrees

Each code reviewer and the claims reviewer gets its own detached worktree of
the PR head, so a probe in one never shows in another:

```bash
root="$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/worktrees"
git worktree add --detach "$root/review-<PR>-<lens>" "$(cat "$R/commit")"
.agents/scripts/worktree.sh --prepare "$root/review-<PR>-<lens>"   # code reviewers only
```

The claims worktree is only read; it needs no prepare. Remove every
worktree after step 4: `git worktree remove --force <worktree>`.

## 3. Spawn

Spawn every review of this round in **one message**, each an Agent call with
`run_in_background: false`, so they run in parallel and your turn cannot
end before their findings are in. The prompt is `key: value` lines and
nothing else: `inputs: $R`, `worktree: <path>` (code and claims),
`round: 1 | 2 | fix-check`, `lens: behaviour | tests | both`
(code), `adr-only: yes` (spec, for that kind). A result without its
findings (still working, or narration): send that agent a message asking
for its findings and wait. Never report a review as missing.

## 4. Verify the blocking findings

A blocking finding is a claim, not a fact. Reproduce its evidence yourself:
read the cited lines, or run the cited command in its worktree, one test
file at a time with the commands in `toolchain.md`. Then:

- **Confirmed**: a Fix line that makes sense without the PR open:
  `<review>: <path:line> <the defect, at most 25 words> [<class>] <src|text>`.
  `<review>` is `spec`, `code` or `claims`; a finding whose fix changes only
  a comment or a doc is `claims`, whichever review raised it. `src` when the
  fix must change production source; `text` when a test, a comment, a doc
  or an assumption line is enough.
- **Rejected**: `<review>: <path:line> <claim> — <why it is wrong, at most
15 words>`. The weekly stats count rejections per review from that tag,
  and the calibration brief shows them to the next reviewers.
- **True but not blocking** (breaks no behaviour, leaves no wrong state,
  breaches no rule, ADR or spec line): reject it with `not blocking: <why>`
  and list it under Notes.
- **Outside this check's scope** (after round 1), when it claims broken
  behaviour or wrong state: verify it like a blocking finding. Confirmed: an
  Out of scope line, `path:line what is wrong`. It does not block this PR;
  the orchestrator opens an issue for it.

Notes are passed on unverified, tagged with their review, as the reviewer
wrote them. A note that claims broken behaviour, wrong state or a rule
breach is a mislabelled blocking finding: verify it as one.

A finding of class `spec vs rule` means the spec is missing a line: resolve
it in favour of the rules and put the missing line under Spec needs.

**Spec needs** is a decision for a person: the orchestrator takes the
conservative option and tells the maintainer, or parks when every option
contradicts a rule or an accepted ADR. Use it only for a confirmed
finding that cannot be fixed without contradicting the spec, a rule or an
accepted ADR, or whose fix would decide behaviour a user sees that nobody
decided. A fix the spec only leaves open is a Fix line ending in
`(record as Assumption: <the choice>)`, but only when one choice is plainly
the conservative one. A fix with two reasonable designs that users would
tell apart is Spec needs: name each option and what a user would see.

## 5. Decide what runs again

Rule 14's rounds: at most round 1, round 2 and one fix check.

| This check | Confirmed `src`               | Only `text` confirmed         | Nothing confirmed |
| ---------- | ----------------------------- | ----------------------------- | ----------------- |
| round 1    | `Rerun: round 2`              | `Rerun: none`, Fix lines kept | `Rerun: none`     |
| round 2    | `Rerun: fix-check`            | `Rerun: none`, Fix lines kept | `Rerun: none`     |
| fix-check  | `Rerun: none`, Fix lines kept | `Rerun: none`, Fix lines kept | `Rerun: none`     |

`Rerun: none` with Fix lines means: when every Fix line is `text`, the
orchestrator runs one text-only fix with no review; when one is `src`
(after `fix-check`), the finding is open and the orchestrator parks the
issue.

## 6. Report

End with exactly this block and nothing else: no summary before it, no
note after it.

```
PR: #M  Round: <1 | 2 | fix-check>  Kind: <the content of $R/kind>  Commit: <sha reviewed>
Spec review: n findings (b blocking) | skipped  Code review: n findings (b blocking) | skipped  Claims review: n findings (b blocking) | skipped
Fix: <one per line, `spec|code|claims: <path:line> <defect> [<class>] src|text`, or "none">
Out of scope: <one per line, `<path:line> <defect>`, or "none">
Notes: <one per line, `spec|code|claims: <path:line> <what could be better>`, or "none">
Rejected: <one per line, `spec|code|claims: <path:line> <claim> — <reason>`, or "none">
Spec needs: <the line the spec is missing, or "none">
Rerun: round 2 | fix-check | none
```

Code review counts both lenses. Every line must stand alone: the
orchestrator pastes Fix lines into the implementer's task, Rejected lines
into the PR body, and Notes into one PR comment.

A PR that is not a delivery PR: post the findings as one comment instead,
confirmed blocking ones under "Confirmed:", notes under "Notes (not
verified):", rejected ones under "Rejected:", ending with
`*Written by an agent.*`. One line per finding, no narration (rule 12).
