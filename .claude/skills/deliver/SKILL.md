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

Rules 1, 2, 9, 14, 15 and 16 in `docs/internal/agent-rules/delivery.md`
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
task's technical spec, checks it for contradictions, links overlapping
tasks under Depends on, and ticks each approval box. If it reports that a
new decision needs an ADR, stop: that is the maintainer's to accept. Park
the feature (step 6) with the decision under Blocked on.

## 3. Deliver one issue

Claim it: `gh issue edit <N> --add-assignee @me`. Its branch is
`<kind>/<N>`.

1. **Implement.** `implement` with `issue #N, branch <kind>/<N>, mode
build`. A report with `spec needs` under Open: park (step 6).
2. **Review.** `review` with the PR number. Fix lines: `implement` with
   mode `fix` and the Fix lines pasted, then `review` again with `round 2`
   and the report's Rerun value. Spec needs, or a confirmed blocking
   finding after round 2: park. Keep every Rejected line.
3. **Hardware.** If implement reported Hardware lines, `verify-hardware`
   with the PR, the branch and those lines. `fail`: `implement` in fix mode
   with the Evidence lines, then `review` round 2 on the code review, then
   `verify-hardware` once more. `busy` or `unavailable`: add the
   `needs-hardware` label to the PR and park; the gate will not merge it.
4. **Finish the PR body.** Walk every Done when line and say how each was
   checked; for the last open sub-issue of a feature, walk the parent's
   Completion conditions too (rule 9). Add the `## Review` section:

   ```markdown
   ## Review

   Spec review: <n> findings, <m> fixed. Code review: <n> findings, <m> fixed.
   Mutate: <n> mutants, <a> alive.

   Rejected:

   - spec|code: <claim> — <reason>
   ```

   Omit "Rejected:" when nothing was. Keep the counts line in exactly this
   shape (`Code review: skipped.` for an ADR-only diff) and paste the
   Rejected lines with their tags: `.agents/scripts/delivery-stats.mjs`
   reads both. Rule 12: 200 words plus the checklist
   and the Review section, ending with `*Written by an agent.*`.

5. **Ready and merge.** `gh pr ready <M>`, then run the gate in the
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
