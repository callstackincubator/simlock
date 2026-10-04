---
name: deliver
description: Deliver a ready issue end to end, unattended — a task, a bug, or a whole feature:ready feature (spec its tasks, then walk them in dependency order, two at a time). Claims, delegates implement, review and hardware checks to their forked skills, reasons only over their report blocks, and merges each PR through the gate. Use when the user says "deliver #N", "pick up the next ready issue", or "ship #N".
---

# Deliver

You are the orchestrator. You never write code, run the suite, or review a
diff yourself. You read issues, decide the next step, invoke the stage
skill for it, and reason over the report block it hands back. That keeps
your context about the issues, not about file contents, so one run can
carry a whole feature.

Rules 1, 2, 3, 9, 14, 15 and 16 in `docs/internal/agent-rules/delivery.md`
govern this skill.

**Delegating.** Invoke a stage with the Skill tool and pass everything it
needs as its arguments: the issue, the branch, the PR once there is one,
the one thing to do, and anything pasted from an earlier report. `implement`,
`review` and `verify-hardware` are forked: each runs in its own sub-agent on
the model its frontmatter pins and hands back only its report. Never start
an Agent that then loads one of them, and never pass a model: either
overrides the frontmatter.

A report without its block, or with narration in place of it, is not a
result: invoke the skill again with the same arguments plus "the last run
ended without its report block; report on the work already done".

**A person present or not.** If a person is in this session, show any text
you are about to post and ask before the slow lane runs. Unattended, post
directly and run the slow lane when the lock is free (rule 16).

**Park only for a person's decision.** A small gap in the spec is not a
reason to stop: implement closes it the conservative way and lists it as
an `Assumption:` line in the PR body, and the spec review checks it (rule
3). Park only for a contradiction with the body, a rule or an accepted ADR;
for behaviour a user would see that nobody decided; for a real-device check
that cannot run; for a blocking finding still confirmed after round 2; or
for what the gate refuses (step 3).

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
2. **Review and hardware, in parallel.** `review` with the PR number. If
   implement reported Hardware lines, invoke `verify-hardware` in the
   **same message**, with the PR, the branch and those lines, so both
   check the commit implement pushed. With a person present, ask before
   that message, since it starts the slow lane.
3. **Decide**, once both reports are in.
   - Fix lines, or Hardware `fail`: one `implement` run in mode `fix` with
     the Fix lines and the hardware Evidence lines pasted together. Then
     round 2: `review` with `round 2` and the report's Rerun value (`code`
     at least when only the hardware failed), and in the same message
     `verify-hardware` again when the fix changed anything but docs.
   - Spec needs, or a confirmed blocking finding after round 2: park.
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
readiness already encodes the order. Deliver up to two runnable tasks at
once: invoke each stage for both in the same message, and keep the two
pipelines apart. Each task has its own worktree, so they never share files.
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
