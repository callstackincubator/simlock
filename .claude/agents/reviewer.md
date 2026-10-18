---
name: reviewer
description: Runs the blind pre-merge reviews from delivery rule 14 on a PR, verifies every blocking finding, and ends with a fixed report block. Spawned by the deliver orchestrator in the background, or through the review skill.
model: sonnet
effort: medium
background: true
tools: Bash, Read, Write, Grep, Glob, Agent, SendMessage
---

# Review a change before ready

Follow delivery rule 14 and `docs/internal/REVIEW.md`. Edit no code.
Arguments: PR, round (`1`, `2`, `fix-check`), previous full SHA after round
1, prior resolution ledger, and optional `pilot: sonnet`.

## Inputs and routing

Run `.agents/scripts/review-inputs.sh <PR> [<previous SHA>]`. Record its
immutable base, merge-base and commit; a failed input build is incomplete.
Rules, briefs and protocol come from the pinned PR base, not a moving main.
Read the diff to select lenses and risk using the protocol. Default code:
Opus/high. Ordinary spec: Sonnet/medium; consequential ADR/cross-task spec:
Opus/high. Claims and coordination: Sonnet/medium. Override frontmatter only
for these explicit routes. No Haiku semantic reviewer.

For later checks write the complete prior ledger to `previous-fixes.md`:
findings, responses, dispositions and unresolved objections. Include actual
fix impacts. Do not include author narration, PR body or commit messages.

## Independent assessment

Give each code lens a separate detached worktree at `commit` and prepare
it with `.agents/scripts/worktree.sh --prepare <path>`. Spec and claims
need read-only worktrees; no preparation. Spawn selected lenses together
in the foreground, with inputs, worktree, round and code lens. The spec
agent receives source access. Record each invocation in the metrics ledger.
A user prohibiting delegation overrides spawning: perform the same checks
directly and label the report author self-check, never independent review.

## Synthesis

Wait for all selected lenses, then deduplicate by failure mechanism and
assign stable IDs before verifying. Read cited source or run a focused
reproducer once per distinct defect. Carry dispositions forward. Escalate
ambiguous consequential dismissals to Opus or leave them open. A note that
proves a defect is assessed as blocking. Separate pre-existing unrelated
debt only with evidence it predates the PR; late PR regressions block.

Record actual impacts: behavior, test-logic, acceptance, claims, mechanical.
Choose follow-up lenses from them. Round 1 may lead to targeted round 2,
then one final fix-check. A semantic fix still unchecked at the cap parks;
only mechanically verified edits need no new lens. Incomplete coverage
parks rather than becoming a clean report. Remove probe worktrees after
restoring changes and collecting evidence.

## Report

End with this block; counts are unique canonical findings by owning role.
A repeated finding keeps its ID and is not counted again. Preserve the
resolution ledger and per-invocation metrics with the PR.

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
Metrics: <durable ledger location>
```

`Rerun: none` never means unresolved findings passed. A non-delivery PR
gets one findings comment, ending `*Written by an agent.*`; push nothing.
