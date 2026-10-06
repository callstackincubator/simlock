---
name: deliver
description: Deliver a ready issue end to end, unattended — a task, a bug, or a whole feature:ready feature (spec its tasks, then walk them in dependency order, two at a time). Claims, delegates implement, review and hardware checks to background agents (two issues at once), reports progress as it goes, reasons only over their report blocks, and merges each PR through the gate. Use when the user says "deliver #N", "pick up the next ready issue", or "ship #N".
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
with everything the stage needs: the issue, the branch, the PR once there is
one, the one thing to do, and anything pasted from an earlier report. Never
pass a model. Never invoke the stage skills from here: a skill waits for an
earlier run of itself, so two implements would run one after the other.

You are woken when an agent finishes; its report is the result. Never poll,
sleep or read an agent's transcript while it runs. A report without its
block, or with narration in its place, is not a result: start the same
agent again with the same prompt plus "the last run ended without its
report block; report on the work already done".

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
dependency order (step 4), not a count of merged tasks.

Every time a stage starts or ends, print one status line and nothing else
around it:

```
HH:MM #<task> (X/Z) <stage> → <started | outcome in a few words>
```

Stages: `spec`, `implement`, `implement fix`, `review r<n>`, `hardware`,
`gate`, `park`. Outcomes are facts from the report: `done, PR #380, 6/6
green`, `2 fixes`, `pass`, `merged`, `parked: <reason>`. Drop `(X/Z)` for a
single issue. Time from `date +%H:%M`.

Asked how it is going: answer from the PR status lines (step 3) and the
status lines so far. To look inside a running agent, ask it with
SendMessage.

**Ask once, then run.** With a person in the session, ask one question up
front: may the slow lane run for every PR of this run (rule 16). Then never
stop to ask: post PR bodies and comments directly, merge every PR the gate
accepts, and apply rule 14's round cap. Ask a person only about what parks
an issue. Unattended, ask nothing: the slow lane runs when its lock is free.

**Park only for a person's decision.** A small spec gap is an `Assumption:`
line, not a stop (rule 3). Park only for:

- a contradiction with the body, a rule or an accepted ADR;
- behaviour a user would see that nobody decided;
- a slow-lane check that cannot run;
- a blocking finding the review reports open after its last round (rule 14);
- what the gate refuses (step 3).

## 1. Take stock

```bash
gh issue view <N> --json number,title,labels,assignees,body
```

- `task:ready`, `bug:ready`: one issue; go to step 3.
- `feature:ready` with a filled Technical spec and no Tasks section: one PR
  delivers it; go to step 3.
- Other `feature:ready`: specify it (step 2), then walk its tasks.
- `feature:planned`: walk its open sub-issues (step 4).
- Anything else, or assigned to someone else: stop and say why (rule 1).

## 2. Specify a feature:ready feature

Run the `spec-session` skill on it in `split` mode, unattended (rule 1). It
writes each task's technical spec, links overlapping tasks under Depends on,
runs the spec check, fixes what the accepted business sections settle, and
only then ticks each approval box. If it reports a finding or decision that
needs a new ADR or the maintainer's choice, park the feature (step 6) with
it under Blocked on.

## 3. Deliver one issue

Claim it: `gh issue edit <N> --add-assignee @me`. Its branch is
`<kind>/<N>`.

1. **Implement**: `implementer` with the issue, the branch and
   `mode build`. `spec needs` under Open: park (step 6).
2. **Review**: `reviewer` with the PR number.
3. **Decide** on the review report:
   - Fix lines: one `implementer` run in mode `fix` with the Fix lines
     pasted, then the next round: `reviewer` with `round <n+1>`, the
     report's Rerun value, `previous <Commit>`, and the Fix lines pasted.
   - `Rerun: claims-only`: the same, with `claims-only` as the Rerun value;
     at most two such rounds per PR. Claims Fix lines still open after the
     second: park.
   - Out of scope lines: open one `bug:new` issue each, naming the PR. They
     do not block it.
   - Spec needs, or a blocking finding reported open with `Rerun: none`:
     park.
   - No Fix lines, and implement reported Hardware lines:
     `hardware-verifier` with the PR, the branch and those lines, on the
     commit the review passed (rule 16). On `fail`: one `implementer` fix
     run with the Evidence lines, then `reviewer` with the next round,
     `Rerun: code`, `previous <Commit>` and the Evidence lines as Fix lines,
     then `hardware-verifier` again on the commit that review passes.
   - Hardware `busy` or `unavailable`: finish the review rounds, do steps 4
     and 5, run `gh pr ready <M>`, add the `needs-hardware` label to the PR,
     and park instead of running the gate.
   - Notes never start a round. Keep every Notes and Rejected line.
4. **Finish the PR body.** Walk every Done when line and say how each was
   checked; for the last open sub-issue of a feature, the parent's
   Completion conditions too (rule 9). Keep `## Assumptions` as it is. Add:

   ```markdown
   ## Review

   Spec review: <b> blocking, <m> fixed, <k> notes. Code review: <b> blocking, <m> fixed, <k> notes. Claims review: <b> blocking, <m> fixed, <k> notes.
   Mutate: <n> mutants, <a> alive.

   Rejected:

   - spec|code|claims: <claim> — <reason>
   ```

   `<b>` counts the blocking findings that review raised over all rounds,
   `<m>` those confirmed and fixed, `<k>` its notes. Every blocking finding
   not fixed is a Rejected line; omit "Rejected:" when there is none. Keep
   the counts line in exactly this shape (for an ADR-only diff:
   `Code review: skipped. Claims review: skipped.`) and the Rejected lines
   with their tags:
   `.agents/scripts/delivery-stats.mjs` parses both. Rule 12 budget: 200
   words plus the checklist, Assumptions and Review, ending with
   `*Written by an agent.*`.

5. **Notes: one comment.** If the reports carried Notes lines, post them
   once, after the last round:

   ```markdown
   ## Review notes

   Not blocking, not verified. Each is one reviewer's claim.

   - spec|code|claims: <path:line what could be better>

   _Written by an agent._
   ```

   A note that is a separate piece of work (a defect outside this diff, a
   refactor across modules) becomes one `bug:new` issue instead, linked from
   that comment.

6. **Ready and merge.** `gh pr ready <M>`, then run the gate in the
   background and wait for its notification, without asking first:

   ```bash
   .agents/scripts/merge-pr.sh <M>
   ```

   Exit 0: merged. Any other exit: park with the line it printed. A
   surviving mutant implement could not explain also parks: the gate does
   not read the report.

After every stage, update the PR body's status line so any session can
resume from GitHub alone:

```
### Status
Implement: done (5/5 green)  Review: round 2, 0 open  Mutate: 0 alive  Hardware: n/a  Gate: merged
```

## 4. Walk a feature's tasks

```bash
read -r OWNER REPO < <(gh repo view --json owner,name -q '"\(.owner.login) \(.name)"')
gh api graphql -F owner="$OWNER" -F repo="$REPO" -F number=<N> -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ issue(number:$number){
      subIssues(first:50){nodes{number title state
        labels(first:5){nodes{name}} assignees(first:3){nodes{login}}}}}}}'
```

Runnable: open, `task:ready`, unassigned. The issue-state workflow makes a
task ready only once its Depends on are closed, so readiness is the order.
After a merge the workflow takes a minute: watch its run
(`gh run list --workflow "Issue state" --limit 1`, then `gh run watch <id>`)
and list again; do not diagnose why a task is not ready yet.

- Deliver up to two runnable tasks at once, each in its own worktree. Start
  a stage for one as soon as the other's agent is running; never wait on one
  task to move the other.
- Both at the hardware check: the second `hardware-verifier` waits for the
  lane's lock (rule 16).
- After each merge, list again.
- A task parks: keep delivering the tasks that do not depend on it.

Stop when nothing is runnable and nothing is in flight.

## 5. End of the run

Post one comment on the feature (or the single issue):

```markdown
## Delivery run

Merged: #PR (#task), ...
Parked: #task — <reason, one line>, ...
Waiting: #task — on #dependency, ...

_Written by an agent._
```

Then send the maintainer a push notification with the same three counts, if
a tool for it exists.

## 6. Parking an issue

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
