---
name: deliver
description: Deliver a ready task, bug or planned feature end to end, unattended — claim, delegate implement, review and hardware stages to background agents, and merge through the gate. Use when the user says "deliver #N", "ship #N" or "pick up the next ready issue".
model: opus
effort: medium
---

# Deliver

You are the orchestrator. Never write code, run tests or review a diff
yourself. Read issues, decide the next step, delegate it, and reason over
the report block that comes back. Rules: `docs/internal/agent-rules/delivery.md`
rules 1, 2, 3, 9, 14, 15 and 16.

**Delegating.** Start each stage with the Agent tool, in the background:
`subagent_type` `implementer`, `reviewer` or `hardware-verifier`; a short
`description` naming the issue and stage (`#362 implement`); and a prompt
whose first line is the ledger tag (`toolchain.md`, "Review measurement"),
then `key: value` lines and nothing else: `issue`, `branch`, `pr` once there
is one, `mode` or `round`, and what the stage works on, pasted from the last
report (`remaining`, `fixes`, the reviewer's arguments). Include immutable `base-sha`, `merge-base`, `head` and, after review,
`previous` plus the resolution ledger. No prose, and no
reminders of what the agent's own instructions already say. Never pass a
model or `isolation`: every stage of a task works in the task's one
worktree, one after another. Never invoke the stage skills from here: a skill waits for an
earlier run of itself, so two implements would run one after the other.

Every stage is a new agent. Never send a finished agent its next stage
with SendMessage: it carries its whole context into every turn, which costs
up to ten times what a new agent does. SendMessage is only for a question
to a running agent, or for a report block that is missing.

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
2. Fold it into the issue body as rule 3 says, the line ending
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

Any output: someone is editing the rules in this checkout, and every agent
of the run would read their unfinished edits (the hooks come from this
checkout too). Stop and tell the maintainer to start the run from a
checkout nobody edits, such as `git worktree add ../simlock-delivery
origin/main`.

```bash
gh issue view <N> --json number,title,labels,assignees,body
```

- `task:ready` whose Depends on allow (delivery rule 1), `bug:ready`: one
  issue; go to step 2.
- `feature:planned`: walk its open sub-issues (step 3).
- Anything else, or assigned to someone else: stop and say why (rule 1).

## 2. Deliver one issue

Claim it: `gh issue edit <N> --add-assignee @me`. Its branch is
`<kind>/<N>`. A task of a feature, or an issue whose feature has an open
ADR PR, is stacked (step 3): its build stage gets `base:` and its PR waits
in the stack instead of the gate. If it already has a PR, read the PR body's `### Status`
section and the latest `## Handoff` comment, and go on from the next stage
they name; never build again or restart review at round 1.

1. **Implement**, one fresh `implementer` per mode, in the **Order**
   `implementer.md` gives. An audit run takes no `fixes`, so a CI failure
   waits for the fix run after the audit (item 2). `spec needs` under
   `open` in any report: decide, then tell (above).
2. **Review**: `reviewer` with the PR number; it picks the lenses
   (`docs/internal/REVIEW.md`). Before every review round
   and every fix run, run `node .agents/scripts/ci-failures.mjs <M>` and
   `gh pr view <M> --json mergeable` once. The script reads the newest
   finished CI run, which is often older than the head: newer pushes cancel
   theirs. Each failed test no open `flaky-test` issue names joins the fix
   run's `fixes` as `ci: <its line> run <id>`, and a conflict as a line
   asking to merge the base branch (`stack: gh stack sync` for a stacked
   PR). With no fix run due, they get one
   before the round.
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
   - After each check persist the resolution ledger, the findings file
     (`docs/internal/REVIEW.md`, "Measurement"), counts and dispositions in
     `## Review`.
   - Out of scope lines may become separate issues only when verified as
     pre-existing and unrelated. New PR regressions block even if found late.
   - Spec needs: decide, then tell (above), before the fix run.
   - No Fix lines, and the audit reported `hardware` lines:
     `hardware-verifier` with the PR, the branch and those lines, on the
     commit the review passed (rule 16). On `fail`, the hardware loop: one
     `implementer` run with `mode: hardware-fix` and the Evidence lines
     under `fixes`, then `hardware-verifier` again on its head; repeat until
     `pass`, with no review in between. After six failed lane runs, park.
     On `pass` after a loop: `reviewer` with `fix-check` and `previous
<the commit the review passed>`, covering every loop commit; its
     fixes affecting device behavior need the lane again.
   - Hardware `busy` or `unavailable`: finish the checks, do items 4
     and 5, run `gh pr ready <M>`, add the `needs-hardware` label to the PR,
     and park instead of running the gate.
   - Notes never start a round. Keep every Notes and Rejected line.
4. **Finish the PR body.** Walk every Done when line and say how each was
   checked; for the last open sub-issue of a feature, the parent's
   Completion conditions too (rule 9). Keep `## Assumptions` as it is. Add:

   ```markdown
   ## Review

   Spec review: <b> blocking, <m> fixed, <k> notes. Code review: <b> blocking, <m> fixed, <k> notes. Claims review: <b> blocking, <m> fixed, <k> notes.
   Rounds: <n>. Tokens: <t>M.
   <the first line review-metrics.mjs prints: Runs: … Cost USD: … Agent seconds: …>

   Rejected:

   - spec|code|claims: <claim> — <reason>
   ```

   `<b>` counts the blocking findings that review raised over all checks,
   `<m>` those confirmed and fixed, `<k>` its notes; `skipped` in place of
   the counts for a review the diff's kind left out (for an ADR-only diff:
   `Code review: skipped. Claims review: skipped.`). `<n>` is the number of
   legacy full/targeted rounds, 1 or 2. Post the `## Review ledger` comment
   as `docs/internal/REVIEW.md` "Measurement" says, fix-checks included:
   one `Round <r>: <full commit>` line per check first, and `round` on
   every finding. Add
   `Assessment: complete` only when coverage is complete and no finding is
   open; otherwise `Assessment: incomplete` and park. `<t>` is
   `tokens=` from `node .agents/scripts/usage.mjs`, this session's usage so
   far (legacy session total, not per-PR cost; use `n/a` when unavailable).
   Keep duplicate outcomes in the ledger, not Rejected. Tag rejections
   `[incorrect]`, `[intentional]` or `[nonblocking]`. Every blocking finding
   not fixed or open has its disposition recorded; omit
   "Rejected:" when there is none. Then run
   `node .agents/scripts/pr-body-check.mjs <M>`: it checks the shape
   `.agents/scripts/delivery-stats.mjs` parses, the footer
   `*Written by an agent.*`, and the rule 12 budget of 200 words outside
   the checklist, Status, Assumptions and Review. Fix what it fails on; cut
   what it says is over budget.

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

   Exit 0: merged. A conflict: an `implementer` fix run that merges the
   base branch. Red CI: one `implementer` fix run with the failing test
   titles and the run id. Either way, the `fix-check` review in item 3
   (none for a fix to tests outside the PR's diff), then the gate again. Any other exit, or red CI a second time: park with the
   line it printed.

After every stage, update the PR body's `### Status` section so any session
can resume from GitHub alone: the status line, then the Fix lines the next
stage works on, if any.

```
### Status
Implement: done (5/5 green)  Review: round 1, 2 behavior findings open  Hardware: n/a  Gate: not run
Next: implement fix, then review round 2
- code: src/x.ts:12 <defect> [testing 2] test-logic
```

## 3. Walk a feature's tasks

```bash
read -r OWNER REPO < <(gh repo view --json owner,name -q '"\(.owner.login) \(.name)"')
gh api graphql -F owner="$OWNER" -F repo="$REPO" -F number=<N> -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ issue(number:$number){
      subIssues(first:50){nodes{number title state
        labels(first:5){nodes{name}} assignees(first:3){nodes{login}}}}}}}'
```

**One stack per feature** (rule 15). The feature's PRs stay open and merge
together at the end, so `main` never holds part of a feature. Bottom to top:
the feature's open ADR PRs (branches `feature/<N>-adr*`, oldest first), then
each task's PR in the order its review passed.

Runnable: open, `task:ready`, unassigned, and every issue under its Depends
on closed or a task of this feature whose PR passed review (open, not a
draft). Check the Depends on yourself; no workflow promotes tasks.

- A task's build stage gets `base: <branch of the stack's top PR>`; with no
  PR yet, no `base` (it starts from `main`).
- Its review passed (step 2, item 6): `gh pr ready <M>` and `gh stack link
<PR below> <M>` (PR numbers, bottom to top; none below yet: nothing to
  link). When its branch did not start from the stack's top (another task
  joined meanwhile), one `implementer` fix run with `fixes: stack: gh stack
sync` brings every branch up to date; a conflict it resolved gets a fix
  check on that PR. PR body Status: `Gate: waiting for the stack`.
- Deliver up to two runnable tasks at once, each in its own worktree. Start
  a stage for one as soon as the other's agent is running; never wait on one
  task to move the other.
- Both at the hardware check: the second `hardware-verifier` waits for the
  lane's lock (rule 16).
- After each `gh pr ready`, list again.
- A task parks: keep delivering the tasks that do not depend on it. The
  stack stays open and nothing merges; the maintainer decides.

**Merging the stack.** When every task has joined the stack and nothing is
in flight, run the gate on the top PR: `merge-pr.sh <top>` gates every PR
in the stack and merges them all, bottom to top. A conflict with `main`
(another feature merged meanwhile): one `implementer` fix run with `fixes:
stack: gh stack sync`, never one merge run per branch; a conflict it
resolved gets a fix check on that PR; then the gate again. Red CI: the fix
run goes to the lowest red PR, then the same sync carries it up.

Stop when nothing is runnable and nothing is in flight.

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
when it never said the computer slept. A closed lid sleeps a laptop, and
nothing runs until it wakes.

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
