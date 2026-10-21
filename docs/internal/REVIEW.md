# Review protocol

Delivery rule 14 delegates its review procedure to this document. Review
one immutable PR snapshot. Use `.agents/scripts/review-inputs.sh <PR>` for
round 1, and add the previous report's full commit SHA for later checks.
The inputs record `base` (base tip), `merge-base`, `commit` and `previous`.
Never substitute `origin/main` for a stacked PR's base. A missing previous
commit makes assessment incomplete. After a rebase or stack sync the
previous commit is no ancestor of the head: give the script that round's
base as well, and it maps the commit to its rebased equivalent when every
commit's patch-id matches; otherwise assessment is incomplete, and nobody
silently performs a full review in its place.
Rules, briefs and this protocol come from the pinned PR base, not a moving
`main`. No reviewer sees author narration (PR body, commit messages) or
another lens's findings before synthesis.

## Precedence and scope

Binding rules and accepted ADRs constrain the spec. Always-in-scope and
required testing coverage apply even when the spec omits them. An exception
requires an explicit maintainer-authorized amendment to the affected rule
or ADR. Review such amendments as changes, not as automatic self-exemptions.
Accepted future-state ADRs remain targets until implemented.

Round 1 covers the whole PR diff. Inspect surrounding code, module manuals,
callers and shared state as needed. Claims review blocks changed claims and
claims the PR makes false, including affected untouched documentation. Read
manuals and flows for context, not as a request to repair unrelated debt.
Unchanged lines can contain PR regressions; demonstrate the causal link.

After fixes, inspect `previous..head`, verify prior resolutions and search
for remaining instances of the confirmed defect classes. Expand only along
affected contracts/dependencies. Existing unrelated defects are separate
follow-up work. A newly discovered PR regression still blocks, including at
the round cap; it cannot be dismissed merely for being late.

## Routing

Choose risk from semantics before choosing models; record the reason.
Ownership, destruction, persistence/recovery, concurrency, trust boundaries
and uncertain blast radius require Opus/high code review, regardless of LOC.
Code review otherwise remains Opus/high by default. Explicit `pilot: sonnet`
permits Sonnet/medium only for routine changes under the evaluation below.
Haiku is not a semantic reviewer or a prerequisite exploration stage.

Spec review uses Sonnet/medium for ordinary acceptance checks; use Opus/high
for ADRs and consequential cross-task decisions. Give it read-only source
access as well as the spec and binding rules. Claims and coordination use
Sonnet/medium. Escalate an ambiguous consequential dismissal to Opus/high;
without that assessment leave the finding unresolved, never rejected.

Select independent lenses by work, not size alone. ADR-only: spec. Docs or
comments: spec and claims. Tests: spec, code/tests and affected claims.
Other changes: spec and code/both, plus affected claims. No issue: skip spec.
Add a separate code/tests lens for complex fixtures or high-risk coverage;
split behavior and tests responsibilities explicitly.
A large mechanical diff alone does not warrant two code reviewers. Record
why a lens was added or skipped. Run selected lenses in parallel, with
separate worktrees for probes; do not share findings until synthesis.

## Synthesis and convergence

Assign stable PR-local IDs (R1, R2, ...) by defect class, affected contract
and failure mechanism, not line number. Deduplicate across lenses before
verification. Verify each distinct defect once with source evidence or a
focused reproducer. Consolidate fixes by class. Keep a resolution ledger:
ID, originating roles, evidence, impact, outcome, reason, fix commit and
verification commit. Outcomes: open, fixed, duplicate (points to canonical
ID), incorrect, intentional, nonblocking. Only incorrect findings are
false positives for calibration; duplicates are coordination overhead.
Carry this history forward; reopening a disposition needs new evidence.

Classify actual fix impact (multiple labels allowed):

| Impact | Follow-up |
| --- | --- |
| behavior | code on changed behavior and affected contracts |
| test-logic | code/tests on assertions, fixtures and their source seam |
| acceptance | spec on changed acceptance, including post-red assertions |
| claims | claims on changed or newly invalidated statements |
| mechanical | coordinator checks the exact diff has no semantic change |

Test files are not automatically mechanical. Claims-only corrections need
a focused claims check; unchanged claims need no repeat review. Use actual
hunks, not the intended fix label, to choose follow-up. A lens whose input
`fix.patch` does not touch does not run: claims needs a changed doc,
comment, test title or printed string; code a changed code or test line.

There is one full round, one targeted round 2, and one final targeted
fix-check. Count every invocation, including that fix-check. After the cap,
any unresolved blocking finding or unchecked semantic fix parks the PR in
draft with the ledger; a maintainer decides the next action. Pure mechanical
edits may be verified by the coordinator without another lens invocation.
No note starts a round unless evidence establishes a blocking defect. Notes go out once, after the last check.

Every reviewer reports `Assessment: complete` or `Assessment: incomplete`
with the missing scope/reason. Budget exhaustion is incomplete coverage,
not a defect and not F0/pass. Stop, preserve findings and escalate the
missing assessment. The coordinator and PR body also carry Assessment;
no incomplete assessment may be marked ready or merged.

## Measurement and cheaper-model evaluation

Nobody writes usage by hand. Every agent prompt a delivery writes starts
with the ledger tag line (`toolchain.md`, "Review measurement"), and
`node .agents/scripts/review-metrics.mjs --pr <M> --issue <N>` reads each
tagged run's model, start, finish, tokens and cost from Claude Code's
transcripts. Unknown values print as unknown, never zero.

The coordinator keeps one findings file per PR, `{"findings": [...]}`, one
entry per canonical finding: `id`, `role`, `class` (the `[class]` the lens
gave, a rule like `testing 2` or at most 8 words), `outcome`, `path`,
`round` (the check that raised it: `1`, `2` or `fix-check`), `fix` (the
fix commit, once fixed) and `canonicalId` for a duplicate. Before the gate,
post one PR comment headed `## Review ledger`: one line `Round <r>:
<full commit>` per check in order, the output of `review-metrics.mjs --pr
<M> --issue <N> --findings <file>`, then the findings file in a `json`
code block. The round lines are what lets a check be frozen and replayed
later (`replay-freeze.mjs`). The
weekly `recurring-findings` routine reads these comments. Record escaped
defects after merge. Do not call raised-minus-fixed a false-positive rate.

Before promoting Sonnet code review, freeze at least 20 representative
historical PR snapshots: at least 10 known-bug and 10 clean, covering ordinary
features, test-only, documentation, stacks, tiny risky and large mechanical
changes. Preserve pre-fix commits and ground-truth defects separately from
reviewer inputs. Run Opus and Sonnet on the same inputs, blind to labels and
each other's outputs. Have a maintainer adjudicate disputed ground truth.
Score canonical findings: critical miss weight 10, major 3, minor 1; report
false positives on clean PRs, incomplete runs, elapsed wall time, total
invocations, cost including verification and fixes, and unknown-data share.
Do not compare only per-call model prices.

Then shadow at least 20 routine live PRs: Opus remains authoritative, Sonnet
runs independently; track escaped defects for 30 days after merge. Proposed
promotion thresholds (maintainer approves): zero critical misses, no higher
weighted miss score than Opus, no higher clean-PR false-positive rate,
and at least 20% lower median total cost with no increase in median review
wall time. Unknown cost/quality data cannot establish promotion. High-risk
work stays Opus. Roll back the routine downgrade on any critical escape or
a weekly increase in weighted misses/false positives versus the baseline.
No pilot has been completed by adding this protocol. The replay harness
runs it: `replay-freeze.mjs` pins a round's head and base and the ledger
as `refs/replay/<PR>/...` on origin, `review-replay.sh` builds the blind
inputs for that snapshot and prints the reviewer's prompt (tagged
`stage=replay`, or one lens with `--lens`), and `review-score.mjs` scores
the findings against the ledger and appends to `.agents/replay/results.jsonl`.
`PROCESS-REVIEW-2026-10-21.md` section 4 says how a change is judged.

The design follows [Anthropic's review convergence findings](https://claude.dev/blog/solving-code-review-at-anthropic/),
[Addy Osmani's risk-focused review](https://addyosmani.com/blog/agentic-code-review/),
and [OpenAI's verification research](https://alignment.openai.com/scaling-code-verification/).
These motivate bounded verification and evaluation, not an assumption that
small models can safely replace every reviewer.
