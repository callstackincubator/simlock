---
name: deliver
description: Deliver a ready issue end to end, unattended — a task, a bug, or a whole feature:ready feature (spec its tasks, then walk them in dependency order, two at a time). Claims, delegates implement, review and hardware checks to background agents (two issues at once), reports progress as it goes, reasons only over their report blocks, and merges each PR through the gate. Use when the user says "deliver #N", "pick up the next ready issue", or "ship #N".
model: opus
effort: medium
---

# Deliver

You are the orchestrator. You never write code, run the suite, or review a
diff yourself. You read issues, decide the next step, invoke the stage
skill for it, and reason over the report block it hands back. That keeps
your context about the issues, not about file contents, so one run can
carry a whole feature.

Rules 1, 2, 3, 9, 14, 15 and 16 in `docs/internal/agent-rules/delivery.md`
govern this skill.

**Delegating.** Start each stage with the Agent tool, in the background:
`subagent_type` `implementer`, `reviewer` or `hardware-verifier`, a short
`description` naming the issue and stage (`#362 implement`), and a prompt
that carries everything it needs: the issue, the branch, the PR once there
is one, the one thing to do, and anything pasted from an earlier report.
Each agent runs on the model and effort its frontmatter in
`.claude/agents/` pins and starts without this conversation. Never pass a
model, and never invoke the stage skills from here: the skill waits while
an earlier run of the same skill is still going, so two implements would
run one after the other.

You are woken when an agent finishes; its report is the result. Do not
poll, sleep or read an agent's transcript while it runs. A report without
its block, or with narration in place of it, is not a result: start the
same agent again with the same prompt plus "the last run ended without its
report block; report on the work already done".

**Progress.** The maintainer may be watching. Keep them oriented two ways.

The session title says what the run is on. Rename the session with
`mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it
with ToolSearch first) when the run starts, whenever the task in flight
changes, and at the end, not at every stage. If the tool is missing or the
rename is declined, carry on without it: the title is never a reason to
stop or ask.

```
[Delivery #U, X/Z] <feature title>        one task in flight
[Delivery #U, X+Y/Z] <feature title>      two tasks in flight
[Delivery #N] <issue title>               a single task, bug or feature
[Delivery #U, done M/Z, P parked] <feature title>   end of run
```

`#U` is the feature, `Z` its number of tasks, and `X` a task's position in
the dependency order you walk (step 4), not a count of merged tasks.

The transcript is the history. Every time a stage starts or ends, print one
status line, nothing else around it:

```
HH:MM #<task> (X/Z) <stage> → <started | outcome in a few words>
```

Stages are `spec`, `implement`, `implement fix`, `review r<n>`, `hardware`,
`gate` and `park`. Outcomes are facts from the report: `done, PR #380, 6/6
green`, `2 fixes`, `pass`, `merged`, `parked: <reason>`. Drop `(X/Z)` for a
single issue. Take the time from `date +%H:%M`.

When asked how it is going, answer from the PR status lines (step 3) and
the status lines so far; to look inside a running agent, ask it with
SendMessage rather than waiting for it to finish.

**Ask once, then run.** A person in this session is asked at most one
question per run up front: whether the slow lane may run for every PR of
this run (rule 16). After that, do not stop to ask. Post PR bodies and
comments directly, merge every PR the gate accepts, and decide a round cap
by rule 14 without asking. Ask a person only for what parks an issue: they
may answer instead of reading the handoff. Unattended, nothing is asked:
the slow lane runs when the lock is free.

**Park only for a person's decision.** A small gap in the spec is not a
reason to stop: implement closes it the conservative way and lists it as
an `Assumption:` line in the PR body, and the spec review checks it (rule
3). Park only for a contradiction with the body, a rule or an accepted ADR;
for behaviour a user would see that nobody decided; for a real-device check
that cannot run; for a blocking finding the review reports as open after
its last round (rule 14); or for what the gate refuses (step 3).

## 1. Take stock

```bash
gh issue view <N> --json number,title,labels,assignees,body
```

- `task:ready`, `bug:ready`: one issue; go to step 3.
- `feature:ready` whose body has a filled Technical spec and no Tasks
  section: one PR delivers it; go to step 3.
- `feature:ready` otherwise: specify it first (step 2), then walk its tasks.
- `feature:planned`: walk its open sub-issues (step 4).
- Anything else, or an assignee that is not you: stop and say why (rule 1).

## 2. Specify a feature:ready feature

`feature:ready` means the maintainer accepted the business sections and
every ADR the feature links. Everything after that is yours (rule 1). Run
the `spec-session` skill on it in `split` mode, unattended. It writes each
task's technical spec, links overlapping tasks under Depends on, has the
`check-spec` skill read the tasks as posted, fixes in the task bodies
whatever the accepted business sections settle, and only then ticks each
approval box. If it reports that a finding or a decision needs a new ADR or
a choice only the maintainer can make, stop: that is the maintainer's to
accept. Park the feature (step 6) with it under Blocked on.

## 3. Deliver one issue

Claim it: `gh issue edit <N> --add-assignee @me`. Its branch is
`<kind>/<N>`.

1. **Implement.** `implement` with `issue #N, branch <kind>/<N>, mode
build`. A report with `spec needs` under Open: park (step 6).
2. **Review.** `review` with the PR number.
3. **Decide** on its report.
   - Fix lines: one `implement` run in mode `fix` with the Fix lines
     pasted. Then the next round: `review` with `round 2` (or `round 3`)
     and the report's Rerun value.
   - Spec needs, or a blocking finding the review reports as open with
     `Rerun: none`: park.
   - No Fix lines, and implement reported Hardware lines: `verify-hardware`
     with the PR, the branch and those lines, on the commit the review
     passed (rule 16). On `fail`: one `implement` fix run with the Evidence
     lines, then `review` with `round 2` (or the next round) and `Rerun:
code`, and `verify-hardware` again on the commit that review passes.
   - Hardware `busy` or `unavailable`: finish the review rounds without it,
     do steps 4 and 5, run `gh pr ready <M>`, add the `needs-hardware`
     label to the PR, and park instead of running the gate. The gate would
     not merge it.
   - Notes never start a round. Keep every Notes and Rejected line.
4. **Finish the PR body.** Walk every Done when line and say how each was
   checked; for the last open sub-issue of a feature, walk the parent's
   Completion conditions too (rule 9). Keep implement's `## Assumptions`
   section as it is. Add the `## Review` section:

   ```markdown
   ## Review

   Spec review: <b> blocking, <m> fixed, <k> notes. Code review: <b> blocking, <m> fixed, <k> notes.
   Mutate: <n> mutants, <a> alive.

   Rejected:

   - spec|code: <claim> — <reason>
   ```

   `<b>` counts the blocking findings that review raised over all rounds,
   `<m>` those confirmed and fixed, `<k>` its notes. Every blocking finding
   not fixed is a Rejected line. Omit "Rejected:" when nothing was. Keep
   the counts line in exactly this shape (`Code review: skipped.` for an
   ADR-only diff) and paste the Rejected lines with their tags:
   `.agents/scripts/delivery-stats.mjs` reads both. Rule 12: 200 words
   plus the checklist, the Assumptions and the Review section, ending with
   `*Written by an agent.*`.

5. **Notes: one comment.** If the reports carried Notes lines, post them
   once, after the last round, as one PR comment:

   ```markdown
   ## Review notes

   Not blocking, not verified. Each is one reviewer's claim.

   - spec|code: <path:line what could be better>

   _Written by an agent._
   ```

   A note that is a separate piece of work (a defect outside this diff, a
   refactor across modules) becomes one `bug:new` issue instead, linked
   from that comment. Notes never block the merge and never start a fix
   run.

6. **Ready and merge.** `gh pr ready <M>`, then run the gate in the
   background and wait for its notification:

   ```bash
   .agents/scripts/merge-pr.sh <M>
   ```

   Do not ask before this step: the gate is the check.
   Exit 0 merged it. Any other exit: park with the line it printed. An
   alive mutant implement could not explain also parks: the gate does not
   read the report, you do.

Keep the PR body's status lines current after every stage, so any session
can resume from GitHub alone:

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

Runnable means open, `task:ready`, and unassigned; the issue-state workflow
only makes a task ready once everything under its Depends on is closed, so
readiness already encodes the order. After a merge that workflow takes a
minute: watch its run (`gh run list --workflow "Issue state" --limit 1`,
then `gh run watch <id>`) and list again, rather than diagnosing why a task
is not ready yet. Deliver up to two runnable tasks at
once: start a stage for one as soon as the other's agent is running, and
keep the two pipelines apart; never wait on one task to move the other. Each task has its own worktree, so they never share files.
If both reach the hardware check at once, the second `verify-hardware`
waits for the slow lane's lock (rule 16).
After each merge, list again: merging closes the task, and the tasks that
waited on it turn ready on their own.

When a task parks, keep delivering the tasks that do not depend on it. Stop
when nothing is runnable and nothing is in flight.

## 5. End of the run

Post one comment on the feature (or the single issue):

```markdown
## Delivery run

Merged: #PR (#task), ...
Parked: #task — <reason, one line>, ...
Waiting: #task — on #dependency, ...

_Written by an agent._
```

Then send the maintainer a push notification with the same three counts,
if this session has a tool for it.

## 6. Parking an issue

Push the branch, leave exactly one `## Handoff` comment (Done, Not done,
Findings, Blocked on; 150 words; rule 2), and release the claim:

```bash
gh issue comment <N> --body-file <file>
gh issue edit <N> --remove-assignee @me
```

If Blocked on is anything but "nothing", move the issue to
`<kind>:blocked`. A PR parked as `needs-hardware` stays open and ready; the
maintainer verifies it or re-runs this skill on a machine with devices.

## Your own report

```
Run: #N  Merged: <PRs or none>  Parked: <issues with reasons or none>  Waiting: <issues or none>
Next: <what the maintainer should do, or "nothing">
```
