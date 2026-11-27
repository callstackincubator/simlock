# Deliver: a feature's tasks and its stack

Step 3 of `SKILL.md`; steps 2, 4 and 5 there apply to every task.

**One stack per feature** (rule 15). The feature's PRs stay open and merge
together at the end, so `main` never holds part of a feature. Bottom to top:
the feature's open ADR PRs (branches `feature/<N>-adr*`, oldest first), then
each task's PR in the order its review passed.

Runnable: open, `task:ready`, unassigned, and every issue under its Depends
on closed or a task of this feature whose PR passed review (open, not a
draft). Read it from `node .agents/scripts/runnable.mjs <N>`: its last line lists the runnable tasks and its `chain` line ends `of <t> tasks`,
the title's `Z`; no workflow promotes tasks. Each `depends-outside
#<d>` line on an open issue is a `Waiting:` line of the run summary (step 4),
and a `B` line (a missing number, a cycle) parks the feature.

- **Before the first build**: the feature's ADR branches fork from an old
  `main`, so run `.agents/scripts/stack-sync.sh <the top ADR PR>` to merge
  `main` forward into them, then start `reviewer` on each open ADR PR
  (round 1, in the background) while the first task builds. An ADR PR
  passes review the way a task's does (step 2, items 3 to 5, ADR-only
  counts) and must be ready before the stack merges; its review never
  waits for the gate to refuse.
- A task's build stage gets `base: <branch of the stack's top PR>`; with no
  PR yet, no `base` (it starts from `main`). As soon as the build reports
  its draft PR, `gh stack link <PR below> <M>` (PR numbers, bottom to top;
  none below yet: nothing to link): the stack is linked at build time, so
  every later sync sees the whole chain.
- Its review passed (step 2, item 6): `gh pr ready <M>`. When its branch
  did not start from the stack's top (another task joined meanwhile), run
  `.agents/scripts/stack-sync.sh <top PR>` yourself: it merges forward,
  bottom to top, in temporary worktrees, and never rebases. It stops on
  the first conflict (`conflict <branch> <parent> <files>`): send that
  task's branch one `implementer` fix run with `fixes: stack: merge
  origin/<parent>`, then step 2 item 3's `fix-kind.mjs`, then the script again.
  PR body Status: `Gate: waiting for the stack`.
- Deliver up to two runnable tasks at once, each in its own worktree. Start
  a stage for one as soon as the other's agent is running; never wait on one
  task to move the other.
- Both at the hardware check: the second `hardware-verifier` waits for the
  lane's lock (rule 16).
- After each `gh pr ready`, run `runnable.mjs` again.
- A task parks: keep delivering the tasks that do not depend on it. The
  stack stays open and nothing merges; the maintainer decides.

**Merging the stack.** When every task has joined the stack and nothing is
in flight: first the feature's ADRs. Each ADR under its Decisions is
_Accepted — not yet implemented_ (rule 10): `node
.agents/scripts/adr-flip.mjs <nnnn> ... --branch <the top PR's branch>`
flips them in one commit, checks it and pushes it; that commit gets no
fix-check. Exit 1: an `implementer` fix run with `fixes: adr: <nnnn> to
Accepted`, then `adr-flip-check.mjs <commit>`. Then run
`.agents/scripts/stack-sync.sh <top>` once more (another feature may have
merged meanwhile), resolve a conflict as above, then the gate on the top
PR: `merge-pr.sh <top>` gates every PR in the stack and merges them all,
bottom to top. Red CI: the fix run goes to the lowest red PR, then the
same sync carries it up. The feature closes itself: the issue-state
workflow closes a `feature:planned` issue when its last sub-issue closes
(rule 9), so post the run summary (step 4) on it and leave it.

Stop when nothing is runnable and nothing is in flight.
