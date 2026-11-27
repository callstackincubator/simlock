# Evaluating a cheaper reviewer model

The maintainer's procedure for changing who reviews; [REVIEW.md](REVIEW.md)
is what a reviewer runs. No review agent opens this file.

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

`replay-freeze.mjs --escaped <file>` adds the bugs a round's review let
through to the pinned truth: the bug's issue, its fix commit, and the file
and lines of the reviewed head that held the defect. Record one only after
reading its fix: `git blame` names the last PR to touch a line, not the one
that made the defect. `review-score.mjs` reports recall on escaped bugs as
its own number: a bug is found only when a blocking finding names its file
and a line inside those lines. Round 1 of #1210, #1235, #1626, #1446 and
#1620 holds 13 such entries for 12 bugs; #1360, #752 and #775 hold none.

A change to the review is judged by replaying each variant on every
snapshot, three runs each. It is adopted when, against the current agents
on the same snapshots, recall over fixed findings and recall on escaped
bugs do not drop, unmatched findings (after adjudication) do not rise, and
the number it targets (minutes, USD, open rate, rule-cited findings) moves
by the amount it claims. Unknown data does not count as improvement.

The design follows [Anthropic's review convergence findings](https://claude.dev/blog/solving-code-review-at-anthropic/),
[Addy Osmani's risk-focused review](https://addyosmani.com/blog/agentic-code-review/),
and [OpenAI's verification research](https://alignment.openai.com/scaling-code-verification/).
These motivate bounded verification and evaluation, not an assumption that
small models can safely replace every reviewer.
