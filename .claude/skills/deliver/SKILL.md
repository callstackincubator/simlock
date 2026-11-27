---
name: deliver
description: Deliver a ready task, a bug (new or ready), a ready refactor or planned feature end to end, unattended — claim, delegate triage, implement, review and hardware stages to background agents, and merge through the gate. Use when the user says "deliver #N", "ship #N" or "pick up the next ready issue".
model: opus
effort: medium
---

# Deliver

You are the orchestrator. Never write code, run tests or review a diff
yourself. Read issues, decide the next step, delegate it, and reason over
the report block that comes back. Rules: `docs/internal/agent-rules/delivery.md`
rules 1, 2, 3, 9, 14, 15, 16, 17 and 18.

**Delegating.** Start each stage with the Agent tool, in the background:
`subagent_type` `implementer`, `reviewer` or `hardware-verifier`; a short
`description` naming the issue and stage (`#362 implement`); and a prompt
whose first line is the ledger tag (`toolchain.md`, "Review measurement"),
then `key: value` lines and nothing else: `issue`, `branch`, `pr` once there
is one, `mode` or `round`, and what the stage works on, pasted from the last
report (`remaining`, `fixes`, the reviewer's arguments). Include `base-sha`, `merge-base` and `head`, copied from the `base`, `merge-base` and `head` lines of `.agents/scripts/pr-shas.sh <M>` run just before the stage starts (never a SHA typed from memory or `git rev-parse`), and, after review,
`previous` plus the resolution ledger. No other prose: a hook adds the
mode's brief or the review protocol to the prompt, so never open or paste
either. Never pass a model or `isolation`: every stage of a task works in
the task's one worktree, one after another. Never invoke the stage skills
from here: a skill waits for an earlier run of itself.

Every stage is a new agent; never send a finished agent its next stage
with SendMessage (its whole context rides along, at up to ten times the
cost). SendMessage is only for a question to a running agent, or for a
report block that is missing.

You are woken when an agent finishes; its report is the result. Never poll,
sleep or read an agent's transcript while it runs. A report without its
block, or with narration in its place, is not a result: ask that agent for
its report block on the work already done. The helpers a stage agent starts
report to you too: when they have all reported and the stage agent has not,
ask it once for its report block.

**Progress.** Rename the session with
`mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it
with ToolSearch first) when the run starts, whenever the task in flight
changes, and at the end. Tool missing or declined: carry on without it.

```
[Delivery #U, X/Z] <feature title>        one task in flight
[Delivery #U, X+Y/Z] <feature title>      two tasks in flight
[Delivery #N] <issue title>               a single task, bug or feature
[Delivery #U, done M/Z, P parked] <feature title>   end of run
```

`#U` is the feature, `Z` its number of tasks, `X` a task's position in the
dependency order (step 3), not a count of merged tasks.

Every time a stage starts or ends, print one status line and nothing else
around it:

```
HH:MM #<task> (X/Z) <stage> → <started | outcome in a few words>
```

Stages: `implement`, `implement fix`, `review r<n>`, `hardware`,
`gate`, `park`. Outcomes are facts from the report: `done, PR #380, 6/6
green`, `2 fixes`, `pass`, `merged`, `parked: <reason>`. Drop `(X/Z)` for a
single issue. The time is the `Local time` your last tool result ends with
(a hook adds it); never write a time you did not read there. When that
line says the computer slept, end the status line with `(slept <m> min)`.

Asked how it is going: answer from the PR status lines (step 2) and the
status lines so far; for a running slow lane, from the lane script's
`status` (`toolchain.md`). To look inside a running agent, ask it with
SendMessage.

**Never stop to ask.** Post PR bodies and comments directly, merge every
PR the gate accepts, and apply rule 14's round cap. Never ask with a
dialog: it stops every task in flight until someone answers. The slow lane
runs whenever its lock is free (rule 16); the argument `no-hardware` turns
it off for the run, and a PR that needs it parks as `needs-hardware`.

**Decide, then tell.** A small spec gap is an `Assumption:` line (rule 3).
A bigger one (`spec needs` in a report, or behaviour a user would see that
nobody decided) does not stop the run either:

1. Take the conservative option: the one closest to what the code does
   today and the easiest to reverse.
2. Fold it into the issue body as rule 3 says (`issue-body.mjs <N>
   replace` or `set-section`), the line ending
   `(decided in delivery, pending the maintainer)`, with a Tests line that
   pins it.
3. Start the next stage on it, with a `decision:` line naming it.
4. Post one PR comment headed `## Decision taken`: the question, each
   option and what a user would see, the one taken and why, and what
   reverting it takes. Say the same in the session, in plain text.

The PR goes on as usual, to the gate or into its stack. An answer that picks another
option is a fix run while the PR is open, and a new `task:draft` issue under
the feature after it merged.

**Park only for:**

- a contradiction with a rule or an accepted ADR;
- a slow-lane check that cannot run, or a hardware loop that gave up;
- a blocking finding the review reports open after its last round (rule 14);
- what the gate refuses (step 2).

## 1. Take stock

```bash
git fetch -q origin && git diff --quiet HEAD origin/main -- .claude .agents
```

Exit 1: this checkout's agents and skills are behind `main`, and the
session loaded the old ones. Stop and tell the maintainer to run
`git pull --ff-only` and start a new session.

```bash
git status --porcelain -- .claude .agents docs/internal/agent-rules
```

Any output: the rules are being edited in this checkout, and every agent
of the run would read the unfinished edits. Stop and tell the maintainer to start the run from a
checkout nobody edits, such as `git worktree add ../simlock-delivery
origin/main`.

```bash
node .agents/scripts/worktree-gc.mjs --apply | tail -1
```

Run it in the background and go on at once: it removes the worktrees whose
work has merged, so the disk the slow lane needs stays free, and takes
about 15 s for each one. Its notification needs no action, whatever it
prints or exits with.

```bash
gh issue view <N> --json number,title,labels,assignees,body
```

- `task:ready` whose Depends on allow (delivery rule 1), `bug:ready`,
  `refactor:ready`: one issue; go to step 2. Several bugs the maintainer
  asked for in one PR (coding rule 3): claim each, deliver the first, and
  give every stage `also: <the others>`.
- `feature:planned`: walk its open sub-issues (step 3).
- `bug:new`, unassigned: triage, then the fast track (delivery rules 8
  and 17). With no triage report on the thread, or a person's reply newer
  than the last one, run the `triage-bug` procedure: start one
  `bug-triager` in the background with the issue number and wait for its
  report. Then, unless the run was started with `no-fast-track`:

  ```bash
  node .agents/scripts/fast-track.mjs <N>
  ```

  Exit 0: the script set `bug:ready`; go to step 2 in this same run. Exit
  1: print the report and the script's `held:` line, and stop; the bug
  waits for the maintainer. Never add `bug:ready` yourself, and never
  argue with a `no` line.

- Anything else, or assigned to someone else: stop and say why (rule 1).

When a Done when line of an issue in the run needs the slow lane, and the
run has no `no-hardware`: run the lane script's `check --fix` (`toolchain.md`)
once, now. What it prints as unfit does not stop the run: say it in one
line, so the machine can be fixed while the first build runs.

## 2. Deliver one issue

Claim it: `node .agents/scripts/claim.mjs <N>`; a refusal says why the
issue is not yours to take (rules 1 and 2): stop there. Its branch is
`<kind>/<N>`. A task of a feature, or an issue whose feature has an open
ADR PR, is stacked (step 3): its build stage gets `base:` and its PR waits
in the stack instead of the gate. If it already has a PR, read the PR body's `### Status`
section and the latest `## Handoff` comment, and go on from the next stage
they name; never build again or restart review at round 1.

1. **Implement**, one fresh `implementer` per mode: `build`, again with
   the last `remaining` while a report lists `remaining` and built a cycle
   since the last; then `audit`. `fix` applies findings, `hardware-fix`
   failing slow-lane tests. A refactor runs `mode: refactor` alone, and its
   review has no spec lens (`--skipped spec` in item 4; rule 18). An audit run takes no `fixes`, so a CI failure
   waits for the fix run after the audit (item 2). `spec needs` under
   `open` in any report: decide, then tell (above).
2. **Review**: `reviewer` with the PR number; it picks the lenses
   (`docs/internal/REVIEW.md`). Before every review round and every fix
   run, run `.agents/scripts/pr-shas.sh <M>` and
   `node .agents/scripts/ci-triage.mjs <M>` once. The triage reads the
   newest finished CI run; act on its lines:
   - `stale:` first (exit 3): the lines after it describe an older
     commit; act on none of them. With `pending`, triage again before the
     next fix run or the gate; with `missing`, the head's run was
     cancelled, and the gate re-runs cancelled jobs once.
   - `flaky`, `unknown`: run its `rerun <id>` lines as
     `gh run rerun <id> --failed`; no fix run.
   - `base` (the branch inherited the failure):
     `.agents/scripts/stack-sync.sh <top PR>`, and let CI run again.
   - `reach`, and `unknown` red a second time: joins the fix run's `fixes`
     as `ci: <its line> run <id>`. A `job <name>` line's indented lines
     are the log's errors and join the same way, never read by hand.
   - `mergeable false` from pr-shas: joins as `stack: merge
     origin/<base-ref>`.

   With no fix run due, they get one before the round.

3. **Decide** on the review report:
   - Incomplete assessment: preserve findings and missing scope; park. It
     is neither a defect nor a pass.
   - Fix lines with `Rerun: round 2` or `fix-check`: one consolidated fix
     run with the immutable base/merge-base, `previous <Commit>`, ledger
     and findings, then `reviewer` with the round `Rerun` names. After a
     rebase or stack sync, the review also gets `previous-base: <the
     base-sha the previous check used>`, so the inputs script can map the
     previous commit across the rebase.
   - `Rerun: none` with unresolved nonmechanical findings or unchecked fixes
     at the cap: park. Mechanical changes get a coordinator diff check.
   - Commits after reviews passed, including conflict resolutions and CI
     test fixes, need the applicable targeted fix-check before the gate.
     A clean base merge alone needs no repeat review; record its new head
     and base and let CI check it. Never silently reset the round cap.
   - Every body edit goes through `node .agents/scripts/issue-body.mjs
     <M> --pr set-section <heading> <file>` (`replace <old> <new>` for
     one line; `<N>` without `--pr` for an issue): the PR body's `##
     Review`, `### Status` and `Notes so far:`, and a decision folded into
     a task body. Never rebuild a body by hand or with inline python.
   - After each check persist the resolution ledger, the findings file
     (`docs/internal/REVIEW.md`, "Measurement"), counts and dispositions in
     `## Review`.
   - Out of scope lines may become separate issues only when verified as
     pre-existing and unrelated. New PR regressions block even if found late.
   - Spec needs: decide, then tell (above), before the fix run.
   - No Fix lines, and the audit reported `hardware` lines:
     `hardware-verifier` with the PR, the branch and those lines, on the
     commit the review passed (rule 16). On `fail`, the hardware loop: one
     `implementer` run with `mode: hardware-fix`, the Evidence lines and
     the load from the report's `Ran:` line under `fixes`, and `previous
     <the commit the review passed>`, then `hardware-verifier` again on
     its head; repeat until `pass`, with no review in between. Every
     verifier run of the loop gets `attempt: <n>`, counting from 1. A
     `base fails:` line in a fix report is a
     test that fails without the PR: every later verifier run gets it as
     `known:`. `spec needs` in a fix report: decide, then tell (above),
     which ends the loop for that test. After six failed lane runs, park.
     On `pass` after a loop: `reviewer` with `fix-check` and `previous
     <the commit the review passed>`, covering every loop commit; its
     fixes affecting device behavior need the lane again.
   - Hardware `pass` with a line `not covered` because its test is
     `known`: the line is unproven. Park as below, the Handoff naming the
     bug the fix run opened.
   - Hardware `busy` or `unavailable`: finish the checks, do items 4
     and 5, run `gh pr ready <M>`, add the `needs-hardware` label to the PR,
     and park instead of running the gate.
   - Notes never start a round. Keep every Notes and Rejected line.
4. **Finish the PR body.** Walk every Done when line: a ticked checklist
   line that keeps the issue's words and adds `— <how it was checked>`
   (`pr-body-check.mjs` matches it by its words); for the last open sub-issue of
   a feature, the parent's Completion conditions too (rule 9). Keep
   `## Assumptions` as it is. Then one command writes the rest:

   ```bash
   node .agents/scripts/review-ledger.mjs <M> --issue <N> --findings <file> \
     --round <r>:<Commit> ... [--skipped <roles>] [--notes <file>] \
     [--rejected <file>] [--incomplete <why>]
   ```

   - `--round`: one per check in order, `<r>` being `1`, `2` or `fix-check`,
     each SHA the
     `Commit` its report gave.
   - `--skipped`: the reviews the diff's kind left out, such as `spec` for
     a refactor or `code,claims` for an ADR-only diff.
   - `--notes`: a file of every Notes line of the reports, each
     `- spec|code|claims: <path:line claim>`.
   - `--rejected`: a file of every Rejected line, each `- spec|code|claims:
     <claim> [incorrect|intentional|nonblocking] — <reason>`. Duplicates
     stay in the ledger, not here.
   - `--incomplete <why>`: when a report's coverage was incomplete.

   It posts the `## Review ledger` comment, writes the body's `## Review`
   (counts, rounds, tokens, cost, Rejected, Assessment) and runs
   `pr-body-check.mjs <M>`, exiting with its code: fix what it fails on,
   cut what it says is over budget. `Assessment: incomplete`: park. Never
   count, write the final `## Review` or run the body check by hand.

5. **Notes: one comment.** If the reports carried Notes lines, post them
   once, after the last round, and remove `Notes so far:` from the PR body:

   ```markdown
   ## Review notes

   Not blocking, not verified. Each is one reviewer's claim.

   - spec|code|claims: <path:line what could be better>

   _Written by an agent._
   ```

   Notes never become issues on their own: a person opens one when a note
   deserves it.

6. **Ready, then stack or merge.** `gh pr ready <M>`. A stacked PR joins
   its feature's stack (step 3) and waits there: no gate. Any other PR:
   run the gate in the background and wait for its notification, without
   asking first:

   ```bash
   .agents/scripts/merge-pr.sh <M>
   ```

   Its `pending` and `re-running` lines need no action. Exit 0: merged. A conflict: an `implementer` fix run that merges the
   base branch. Red CI: one `implementer` fix run with the failing test
   titles and the run id. Either way, the `fix-check` review in item 3
   (none for a fix to tests outside the PR's diff), then the gate again. Any other exit, or red CI a second time: park with the
   line it printed. `held by the fast track` (rule 17) parks like any
   refusal: Blocked on is the script's `held:` line and "the maintainer
   merges the PR, or removes `fast-track`"; the PR stays ready.

After every stage, update the PR body's `### Status` section (`issue-body.mjs
<M> --pr set-section Status <file>`) so any session can resume from GitHub
alone: the status line, then the Fix lines the next stage works on, if any.

```
### Status
Implement: done (5/5 green)  Review: round 1, 2 behavior findings open  Hardware: n/a  Gate: not run
Next: implement fix, then review round 2
- code: src/x.ts:12 <defect> [testing 2] test-logic
```

## 3. Walk a feature's tasks

Read `feature.md`, next to this file, before the first step on a
`feature:planned` issue and before the build of any stacked issue: the
stack, which tasks are runnable, two tasks at once, merging the stack. A
single issue that is not stacked never needs it.

## 4. End of the run

Post one comment on the feature (or the single issue):

```markdown
## Delivery run

Merged: #PR (#task), ...
Parked: #task — <reason, one line>, ...
Waiting: #task — on #dependency, ...
Decided: #task — <question> → <option taken>, ...
Asleep: <m> min

_Written by an agent._
```

`Asleep` is the session total the clock hook last gave; leave the line out
when it never said the computer slept.

Then send the maintainer a push notification with the same three counts, if
a tool for it exists.

## 5. Parking an issue

Push the branch, leave exactly one `## Handoff` comment (Done, Not done,
Findings, Blocked on; 150 words; rule 2), and release the claim:

```bash
gh issue comment <N> --body-file <file>
gh issue edit <N> --remove-assignee @me
```

Blocked on is not "nothing": move the issue to `<kind>:blocked`. A PR parked
as `needs-hardware` stays open and ready; the maintainer verifies it or
re-runs this skill on a machine that can run the slow lane.

## Your own report

```
Run: #N  Merged: <PRs or none>  Parked: <issues with reasons or none>  Waiting: <issues or none>
Next: <what the maintainer should do, or "nothing">
```
