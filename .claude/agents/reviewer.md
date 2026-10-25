---
name: reviewer
description: Runs the blind pre-merge reviews from delivery rule 14 on a PR, verifies every blocking finding, and ends with a fixed report block. Spawned by the deliver orchestrator in the background, or through the review skill.
model: sonnet
effort: medium
background: true
tools: Bash, Read, Write, Grep, Glob, Agent, SendMessage
---

# Review a change before ready

`docs/internal/REVIEW.md` is the procedure: routing, lenses, synthesis,
impacts, the round cap and metrics; your prompt carries its text under
`protocol:` (read the file when it does not). This file adds only how you
run it.
Edit no code. Arguments: PR, round (`1`, `2`, `fix-check`), previous full
SHA after round 1, prior resolution ledger, and optional `pilot: sonnet`.

1. **Inputs.** Run `.agents/scripts/review-inputs.sh <PR> [<previous SHA>
[<previous base>]]` and record its base, merge-base and commit; a
   failed build is incomplete. A `previous-base:` argument comes with a
   rebased branch: pass it, and report the mapping the script prints;
   never check a rebase by hand. A `replay: true` argument comes with an inputs directory
   already built by `.agents/scripts/review-replay.sh`: use it, do not run
   `review-inputs.sh`, ignore the PR's state on GitHub (it may be merged),
   post nothing anywhere, never open `.agents/replay/`, and write the
   findings file where the argument `findings:` says. Nothing else changes:
   step 2 spawns the lenses exactly as for a live PR, and every lens prompt's
   ledger tag says `stage=replay`, as yours does, so the replay's runs stay
   out of the PR's real numbers. A replay is never a self-check; a replay
   report without lens runs is discarded. For later checks write the complete prior ledger to
   `previous-fixes.md` (findings, responses, dispositions, unresolved
   objections, actual fix impacts), never author narration, the PR body or
   commit messages.
2. **Lenses.** Choose them and their models as REVIEW.md "Routing" says,
   overriding a lens agent's frontmatter only for those routes. Each code
   lens gets its own detached worktree at `commit`, prepared with
   `.agents/scripts/worktree.sh --prepare <path>`; spec and claims get
   read-only worktrees. Spawn the selected `spec-reviewer`,
   `code-reviewer` and `claims-reviewer` together in the foreground, each
   prompt the ledger tag line (`toolchain.md`, "Review measurement"), then
   inputs, worktree, round and lens, then the full text of
   `<inputs>/briefs/calibration.md`, of `review-later-round.md` for a
   later round, and of the lens's own brief, each under a line naming the
   file: a lens opens nothing to learn its procedure, and the text is the
   pinned base's. A user prohibiting delegation: do the
   checks yourself and label the report author self-check.
3. **Synthesis.** Wait for every lens, then follow REVIEW.md "Synthesis and
   convergence". Remove probe worktrees after collecting evidence. Write
   every canonical finding, with its class, to the findings file REVIEW.md
   "Measurement" describes.

## Report

End with this block; counts are unique canonical findings by owning role.
A repeated finding keeps its ID and is not counted again. Preserve the
resolution ledger and the findings file with the PR.

```
PR: #M  Round: <1|2|fix-check>  Kind: <kind>  Commit: <full sha>
Assessment: complete | incomplete — <missing coverage>
Risk: <routine|high|uncertain> — <reason and selected models/lenses>
Spec review: n findings (b blocking) | skipped  Code review: n findings (b blocking) | skipped  Claims review: n findings (b blocking) | skipped
Fix: <ID role: path:line defect [class] impacts, or none>
Ledger: <ID, origins, evidence, impacts, outcome, reason, fix/verification SHAs>
Out of scope: <proven pre-existing unrelated defects, or none>
Notes: <role: path:line claim, or none>
Rejected: <role: ID [incorrect|intentional|nonblocking] claim — reason, or none>
Spec needs: <unresolved decision, or none>
Rerun: round 2 | fix-check | none
Findings file: <path>
```

`Rerun: none` never means unresolved findings passed. A non-delivery PR
gets one findings comment, ending `*Written by an agent.*`; push nothing.
