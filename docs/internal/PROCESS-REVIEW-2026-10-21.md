# Process review, 2026-10-21

What the deliver and spec runs after the review change in #739 (merged
2026-10-19 22:35) show, what we change, and the measurement each change
is judged by. Nothing here is adopted on belief: a change stays only when
its number moves.

## 1. Scope and method

Runs read: `deliver` for #707 (alerts), #700, #754 (state.db), #771 (warm
pool) and bugs #698, #699, #750; `spec-session` for #754, #771, #756. That
is 15 PRs (14 merged), 227 tagged agent runs, every `## Review ledger`,
`## Handoff` and `## Delivery run` comment, and the orchestrator and
subagent transcripts under `~/.claude/projects`.

Tooling used: `review-metrics.mjs` per PR, `delivery-stats.mjs --since
2026-10-19`, and three throwaway scripts over the transcripts (a session
timeline, a per-agent tool-call breakdown, an instruction-file open-rate
counter). The last one becomes a repo script (section 5).

## 2. Findings

### 2.1 Where the time went

| Run  | Wall   | Idle, no agent | Asleep  | Outcome                          |
| ---- | ------ | -------------- | ------- | -------------------------------- |
| #707 | 2h22   | 18 min         | 0       | 4 PRs merged                     |
| #700 | 4h50   | 122 min        | 0       | 2 PRs, merged later              |
| #754 | 3h55   | 35 min         | 0       | 6 PRs, parked at the cap         |
| #771 | 10h32  | 9 min          | 404 min | 1 parked, 1 build cut by budget  |
| bugs | 30–61m | 2–16 min       | 0       | merged                           |

- The build is the longest single stage and it is model time, not tool
  time (3 of 51 minutes waiting on tools in the biggest build). #761 took
  51 min plus 7 helpers for 9000 lines and 16 Tests lines; #776 needed
  three continuation agents for 21 Tests lines.
- A review invocation is 5–11 min: the Opus code lens 4–10 of them, the
  Sonnet coordinator 2–4 on top. What makes review "take ages" is the
  chain around it. Review plus fix agent minutes per PR: 12–24 typical;
  #745 84, #752 65, #775 61, #788 52. The outliers are CI and flake
  investigations between rounds and the round cap chain.

### 2.2 Obstacles, by cost

1. **Stale stacked bases.** ADR branches fork from an old `main` and are
   never moved; task branches inherit red CI and missing code. The
   docs-manuals test is 8 of the 28 `ci:` fix lines; two builds built
   nothing (#708); 12 stack-sync fix runs; a rebase with 30 red tests
   (#700); a gate refusal on the ADR PR's red CI (#707).
2. **Stacks: the tool, not the idea.** `gh stack rebase` failed 11 of 14
   times, `sync` 3 of 5, 7 pushes were refused. Causes: rebase needs a
   force push and `settings.json` denies `git push --force*`; gh stack
   assumes one checkout and switches branches while the project runs one
   worktree per task; every rebase conflicts on the ADR index and shared
   docs; the stack is linked after review, so branches drift. The run that
   needed no human (#754) never rebased: it linked PRs and merged forward.
3. **CI flakes consume fix runs.** 28 `ci:` lines over 15 PRs; at least 4
   fix runs changed nothing (about 50 agent minutes), each also costing a
   CI cycle and often a fix-check. 27 of the 28 lines are e2e, timing,
   console or the docs test; unit flakes are rare.
4. **Human in the loop in #700**: about 75 min waiting on pushes, plus 41
   min from a collision with the gate session on #684. Reviews then ran
   on unpushed commits and #749 needed a third full round.
5. **ADR PR reviewed only when the gate refused** (#754; #707's ADR got
   its review in a separate gate session). The deliver skill has no step
   that reviews the ADR PR early.
6. **Round cap parks on late findings.** #775 parked with R15 unreviewed,
   #788 with R5 first seen in a fix-check. Later rounds find siblings of
   round-1 findings: #775 R10–R12 are the class of R1 and R3.
7. **Smaller:** two fix-checks came back incomplete after a rebase
   (previous not an ancestor) and fell back to self-check; the budget
   guard counted 404 min of Mac sleep as active and cut #771's audit; four
   PRs (#741, #744, #745, #746) have no Review ledger comment; `Tokens:
   n/a` on three.

### 2.3 Review quality

45 ledger findings: 38 fixed, 0 incorrect, 3 nonblocking, 3 duplicates, 1
open. About 10 are behaviour bugs (deleting a user's own directories in
#752, unproven identity in #751, STRICT INTEGER refusals in #775, a `-h`
bypass in #745, a retry schedule in #788); about 20 are test-coverage
classes; the rest are false doc claims. The audit does not catch the
test-coverage ones: #775 reported "29/29 probed" and review still found
three test-logic findings; #784, #785, #786 likewise.

### 2.4 Spec sessions

Blocking checker findings at the split on 2026-10-20: #754 15 (5 tasks),
#771 25 (3 tasks + feature), #756 61 (7 tasks + feature). Every report
carries exactly 5 notes: a quota, not findings. About half the blocking
ones are writing defects (untested, contradiction, derived-list), half are
decision gaps (undefined, boundary, failure-mode, fact) that the interview
should have asked. The checker runs after the tasks are written, so
decision gaps come back as a second decision round, and 58% of round-2
findings sit in text written to fix round 1 (measured 2026-10-16).

### 2.5 Tests

Tests on `main`: 1,739 on 30 Sep, 3,570 on 7 Oct, 5,427 on 14 Oct, 6,483
on 21 Oct. Test code is 2.25× the source (1.22× on 30 Sep). The 15 Oct
"fewer, stronger tests" rules did not bend the curve. Tests added per PR
track the spec's Tests lines one to one (#741: 26 lines, 30 tests; #775:
21 lines, 52 tests; #786: 4 lines, 2 tests), so the count is decided at
spec time, by the checker's `untested` category (a Tests line per
behaviour sentence, "as today" included), the template's line per Failure
modes row, and review's testing-class findings. CI is not the cost (unit
176 s; Console 739 s, Timing 316 s); agent time is.

### 2.6 Instructions

The instruction set is about 55k tokens (rules 21k, skills 14k, agents 8k,
briefs 9k) plus 57k of module manuals and flows. Open rates per role, from
227 runs: build implementers opened the brief 18/29, `testing.md` 3/29,
`coding.md` and `always-in-scope.md` 0/29; fix implementers the brief
40/54; code lenses calibration 31/31, the code brief 23/31, `testing.md`
9/31; spec lenses calibration 23/23, the spec brief 2/23. Lens prompts are
250–450 characters pointing at a directory. Only the agent definition is
guaranteed to be read. About 18 of 45 ledger findings cite a rule number:
the reviewer enforcing what the implementer never opened. A build run's
first turn is about 13.5k tokens of context; the run then writes 820k
cache tokens of code and tool output. Instruction tokens are not the
cost; being read is.

## 3. What we change

Each item names its measurement. Numbers in parentheses are today's.

### Spec session

1. Check the feature body and its Shared values table before any task is
   written; its undefined, boundary and failure-mode findings become the
   last interview round. Measure: blocking findings per task at round 1
   (1–10); decision rounds after the split (1 per session).
2. Derive task Tests lines from the feature's behaviour-to-test ledger.
   Measure: untested and contradiction findings per task.
3. Drop the checker's 5-note quota.
4. Cap a task near 8–10 Tests lines, not 30. Measure: build minutes and
   continuation builds per task.

### Tests

5. The Tests section is invoker scenarios: one line per thing an invoker
   does and sees, cases as a table in one test, at the module or host
   surface with the platform faked, not end to end.
6. `untested` applies to invoker-visible outcomes only; internal order,
   unobservable fallbacks and "as today" are notes at most.
7. Drop testing rule 3's "every path in a strict area", or confine it to
   the named safety modules.
8. The weekly mutation run deletes: a test with no unique mutant kill
   whose claim a surface test already proves goes. Measure for 5–8: tests
   per Tests line (1.1), test LOC per source LOC (2–4×), tests per week on
   `main` (+1,000), escaped defects within 30 days.

### Delivery and stacks

9. Sync by merge-forward, never rebase: a project script links the stack
   at build time, merges base into each branch bottom to top inside the
   task worktrees, never touches local `main`; the ADR index is generated.
   Measure: stack-command failures per run (11/14), human-wait minutes,
   stack-sync fix runs per feature (3).
10. Sync the ADR base to `main` and wait for its green CI before the first
    build. Measure: `ci:` lines per PR (28/15), builds that built nothing.
11. Review the ADR PR at run start, in parallel with the first build.
    Measure: gate refusals per run.
12. Triage CI before a fix run: in the PR's reach, known flaky, or
    base-inherited; only the first gets an implementer. Measure: fix runs
    that changed nothing (4).

### Review

13. Round 1 exhausts each confirmed defect class. Replay #775 and #744:
    do R10–R12 and R4 appear in round 1?
14. The audit uses the review's testing checklist. Measure: testing-class
    findings per PR after audit (about 1.3).
15. Cheaper fix-checks: no spec lens, coordinator takes mechanical diffs.
    Replay the fix-check snapshots that found something (#745 R9, #788 R5,
    #775 R13–R17).

### Instructions

16. `AGENTS.md` stays a router, routing by role: which role reads which
    three or four files; one hop, then stop.
17. Each agent file carries its role's imperatives inline (600–900
    tokens); the rule files become the reference a finding cites.
    Ceremony goes; a one-sentence why stays where the rule is surprising.
18. Skills become steps with commands and exit conditions.
    Measure for 16–18: open rate per role per instruction file; rule-cited
    findings per PR; replay recall unchanged.

### Small fixes

19. The budget guard uses the monotonic clock `clock.mjs` already has.
20. `pr-body-check.mjs` requires the Review ledger comment.
21. The reviewer rebuilds inputs from the new base after a rebase instead
    of self-checking.
22. The reviewer's ledger comment records the commit of every round, so a
    snapshot can be frozen from GitHub alone (section 4).

### Order

Section 4 first: 13–15 and 17 cannot be judged without it. Then 9 and 10,
which remove the most wall-clock with no model work. Then 1, 4, 5 and 6
together as one spec-session change, measured on the next feature.

## 4. What must exist first: the replay harness

The review protocol already describes this evaluation ("freeze at least 20
representative historical PR snapshots … run on the same inputs") and
nobody has run it. Every review and instruction change above is measured
by replaying a frozen PR snapshot and scoring the findings against the
ledger.

### 4.1 Facts that shape it

- Task branches are deleted at merge and `main` is squash-merged, but
  `refs/pull/<n>/head` survives and every round's head is an ancestor of
  it (checked: #775's round-1 head 551e6ec6 and #752's a1c5a6f6 are
  reachable). A stacked PR's base tip is reachable through the PR below.
- `review-inputs.sh` takes the live head from `refs/pull/<n>/head` and the
  base from `origin/<base_ref>`; after merge the base branch is gone. It
  needs pinned SHAs.
- The ledger JSON has `path`, `class`, `outcome` and the `fix` commit but
  not the commit each round reviewed. For the 15 PRs below the round heads
  come from the transcripts; for future PRs item 22 puts them in the
  ledger comment.
- Four PRs (#741, #744, #745, #746) have no ledger JSON; their ground truth
  is reconstructed from the reviewer reports in the transcripts.

### 4.2 Pieces

1. **`review-inputs.sh` accepts `REVIEW_HEAD` and `REVIEW_BASE`** (full
   SHAs). When set it skips the two fetches, uses the SHAs, and still
   takes rules, briefs and the protocol from `REVIEW_BASE`. Everything
   else (issue, feature, kind, stale refs, tests-after-red) is unchanged.
2. **`replay-freeze.mjs <PR> --round <r> --head <sha> --base <sha>
   [--previous <sha>]`** writes `.agents/replay/<PR>.json`: the snapshot
   per round, the ledger findings as ground truth (with outcome, so
   `incorrect` and `nonblocking` ones score as known non-defects), the
   kind, and the baseline minutes and USD from `review-metrics.mjs`. It
   verifies each SHA is reachable from `refs/pull/<PR>/head` or the stack
   below, and pushes `refs/replay/<PR>/<round>/{head,base,previous}` to
   origin so the snapshot survives GC on every machine (a ref namespace,
   no branch, no tag, nothing in the PR list).
3. **`review-replay.sh <PR> <round>`** reads the snapshot, fetches the
   replay refs, runs `review-inputs.sh` with the pinned SHAs, prepares a
   detached worktree at the head with `worktree.sh --prepare`, and prints
   the prompt for the `reviewer` agent: the ledger tag with
   `stage=replay` (so `review-metrics.mjs` and `delivery-stats.mjs` keep
   replays out of the real numbers), the inputs directory, the worktree
   and `replay: true`. A replay reviewer writes its findings file and
   posts nothing.
4. **`review-score.mjs --pr <PR> --round <r> --findings <file>`** matches
   the replay's findings to ground truth by path (file, not line) and
   class token overlap, prints recall over `fixed` findings, weighted by
   impact where the ledger has it (behaviour 3, test-logic and claims 1),
   the unmatched replay findings as candidates for adjudication, and the
   minutes and USD of the tagged run. It appends one row to
   `.agents/replay/results.jsonl`: PR, round, variant label, recall,
   unmatched, minutes, USD, the agents and briefs commit.
5. **`instruction-reads.mjs [--since <date>]`** counts, per role and per
   instruction file, how many tagged runs opened it (the open-rate metric
   for items 16–18), and reports it beside `delivery-stats.mjs`.
6. **Counters in `delivery-stats.mjs`** for items 9–12 and 4–8: `ci:` lines
   per PR, stack-sync runs per feature, builds that built nothing, fix runs
   that changed nothing, tests added per Tests line, test LOC per source
   LOC. All read from the tagged transcripts and the PR diff.

A variant is a branch of `.claude/agents`, `.agents/briefs` and
`docs/internal/agent-rules`; the replay script takes rules and briefs from
`REVIEW_BASE` today, so it also needs a `--rules <ref>` override to review
an old snapshot with new instructions. Each variant is replayed on the
same snapshots, three times each because reviewer output varies; the
result row carries the variant label.

### 4.3 Ground truth to freeze now

Round-1 snapshots (head, base) from the transcripts of these runs:

| PR   | Round-1 head | Base       | Ledger findings | Later-round findings worth their own snapshot |
| ---- | ------------ | ---------- | --------------- | --------------------------------------------- |
| #741 | 558b1472     | 0ff6bdaf   | reports only    |                                               |
| #744 | 87886426     | 27101aea   | reports only    | R4 at round 2 (head 00b8fac4, prev 87886426)  |
| #746 | eda30e7b     | 3f6a9ac9   | reports only    |                                               |
| #745 | 4dc68601     | d4edbd3d   | reports only    | R9 at fix-check (head 9b2163b3, prev 9c6ebe84)|
| #749 | 8704234d     | cc5ef002   | reports only    |                                               |
| #751 | d241e329     | 85d3311c   | 7               |                                               |
| #752 | a1c5a6f6     | 85d3311c   | 6               |                                               |
| #753 | c1f6ff28     | 8db8112b   | 3               |                                               |
| #755 | f0eec441     | 97bc8eaf   | 6 (ADR, spec)   |                                               |
| #775 | 551e6ec6     | f0eec441   | 12              | R10–R12 at round 2 (head 6ae6e993, prev 551e6ec6); R13–R17 at fix-check (head 6c4df08a, prev bc24123e) |
| #783 | 1b50737f     | 3cf805d2   | 0 (clean)       |                                               |
| #784 | 1cd2ac2c     | 3cf805d2   | 2               |                                               |
| #785 | e0567de8     | 05524eca   | 2               |                                               |
| #786 | adcecadb     | 83c80023   | 2               |                                               |
| #788 | 6c5e65df     | 80cba395   | 5, 1 open       | R5 at fix-check (head 8dbbe671, prev 0020a846) |

That is 15 round-1 snapshots, one clean, plus five later-round ones. The
protocol asks for at least 20 with 10 known-bug and 10 clean; the five
older PRs #733, #723, #722, #710 and #587 (reviewed 2026-10-20 in the
gate session) extend it, and clean ones are the easier half to add.

### 4.4 How a change is judged

Replay each variant on every snapshot, three runs each. A change is
adopted when, against the current agents on the same snapshots: recall
over fixed findings does not drop; unmatched findings, after adjudication,
do not rise; and the number it targets (minutes, USD, open rate,
rule-cited findings) moves by the amount its item claims. Unknown data
does not count as improvement.

### 4.5 The first example: PR #752, round 1

Built and run on 2026-10-21 (pieces 1–4 of 4.2; the snapshot is pinned
as `refs/replay/752/1/{head,base}` and the truth as `refs/replay/752/truth`).
The original round 1: 4 runs, 10.6 min, $1.38, 6 findings, all fixed.

| Run | Lenses ran | Recall of the 6 | New findings       | Min  | USD  | Note                                   |
| --- | ---------- | --------------- | ------------------ | ---- | ---- | -------------------------------------- |
| 1   | yes        | 4/6             | 3                  | 12.1 | 1.41 | contaminated: coordinator read the truth file |
| 2   | no         | invalid         |                    | 0.6  | 0.12 | coordinator self-checked                |
| 3   | no         | invalid         |                    | 1.6  | 0.23 | coordinator self-checked                |
| 4   | yes        | 4/6             | 2                  | 13.8 | 1.69 | clean                                   |

What the two valid runs say about the reviewer:

- Both reproduced the same four: the spec line not delivered (R5), the test
  staged in the wrong directory (R2), the pid never proven to reach the
  sweep (R3), the uid read instead of injected (R4).
- Both missed the two safety findings (R1, R6: the sweep's name pattern
  matches a user's own directories and deletes them). Run 4's coordinator
  saw exactly that defect and wrote it as a note: "name-only matching is
  narrow, so I did not make it a finding." The original code lens proved
  it with a throwaway test. The miss is a synthesis judgment, not
  blindness, and it is the most severe finding of the PR. Candidate change
  for the protocol, measurable here: a candidate in a safety class is
  never downgraded at synthesis without a probe.
- Both raised one finding the original review did not: the `.tmp` and
  `.staging` name formats are copied into the sweep as regexes, with no
  test tying them to the code that writes them (architecture 10). It needs
  adjudication; two independent runs agreeing makes it a likely true miss
  of the original.
- Cost and time per valid replay match the original within 25%.

What the example says about the harness. Four defects surfaced, three
fixed on the spot:

1. The coordinator opened the snapshot file and read the answers before
   its lenses ran. Fixed: the truth lives only on origin as a blob
   (`refs/replay/<PR>/truth`); the snapshot file holds SHAs and the
   baseline; the replay clause forbids opening `.agents/replay/`.
2. Two of four coordinators skipped their own step 2 and self-checked.
   Fixed: the replay clause says lenses run exactly as for a live PR;
   the scorer marks a run with no lens runs invalid.
3. One coordinator wrote `stage=review` into its lens tags, so three lens
   runs now count in #752's real local metrics (18 runs became 21; the
   ledger comment on the PR is unaffected). Fixed going forward in the
   reviewer's replay clause; the scorer claims review runs started after
   the replay's `started:` time, which is safe because a merged PR has no
   live reviews.
4. A finding naming several files (`a.ts:12 (and b.ts:40, main.ts:7)`)
   matches only on full paths; `main.ts` alone does not match
   `src/daemon/main.ts`. Open: hand adjudication covered it this time.

Verdict for the example: not worse. The replay reproduces the review's
findings at the original's cost, the misses are consistent and explainable,
and the harness already produced one measurable protocol change (the
safety-class downgrade) and one candidate escaped finding. Next: #775
round 1 and round 2 (the sibling-class question, item 13), and a lens-level
mode in `review-replay.sh` for questions about one lens, which the 19 Oct
experiment under `/tmp/replay` answered by hand and which avoids the
coordinator's drift entirely.

### 4.6 The second example: PR #775, round 1

Pinned as `refs/replay/775/1/*` and `refs/replay/775/2/*`, truth
`refs/replay/775/truth` (12 findings: 10 defects, 2 nonblocking). The
original round 1: 5 runs (two Opus code lenses), 32 min, $6.63.

One clean replay: 5 runs, 34 min, $6.47, 8 canonical findings. The scorer
matched 3; by hand 6 of the 10 defects are reproduced (the replay's R2
names both STRICT INTEGER columns, R4 is the same unproven order on the
same test, R6 names `domain.ts:25` beside `registry.ts`). Missed: the fake
table accepting extra keys (R3, R11), the option-over-module order (R5)
and the REAL-column test (R12).

Two observations that bear on the changes above:

- **Item 13 has its first data point.** The real round 1 found the ttl
  column (R1) and round 2 found its sibling, the retry column (R10). The
  replay's round 1 found both in one finding. Round-1 exhaustion of a
  class is within the reviewer's reach; what varies is whether it looks.
- **The replay found the socket probe two rounds early.** Its R1, "no
  daemon-socket probe before `openStateDatabase`", is the defect the real
  review raised only at the fix-check as R13, where it became a delivery
  decision on the ADR PR. A round-1 miss of a behaviour defect cost two
  fix runs and a decision taken in delivery.

Candidates for adjudication from the replay: refusal tests in
`registry.test.ts` never show an accepted load first (testing 2); the
core manual says drivers own their DeviceDataTable.

The lens-level mode (`review-replay.sh --lens`) was checked on #752's spec
lens: 26 s, $0.12, its one owned finding reproduced, three new ones for
adjudication, among them EPERM counted as a dead pid, which the real review
did not raise. The scorer reads lens reports (`F1 B path:line … [class]`)
and judges a lens on the findings its role owned.

**Round 2 of #775**, replayed with the real round-1 ledger in the prompt:
3 runs, 14 min, $1.60 (original 3 runs, 13 min, $1.72). It raised exactly
the three findings the real round 2 raised: the retry column (R10), the
e2e fake table accepting extra keys (R11) and the untested `lease_grants`
columns (R12), and verified the seven fixes the same way. So the targeted
round is reproducible, and the sibling search it does is what round 1 can
do earlier (item 13).

Harness follow-ups from this example: the truth needs the round each
finding was raised in, so a later-round replay is scored on its own
findings (today the carried-forward entries score as noise); the ledger
comment should carry it (item 22). A coordinator that reviews a later
round without the round-1 texts marks them "not carried"; the replay
prompt should include the prior ledger verbatim, as the orchestrator's
does.

### 4.7 Where this leaves the harness

Two PRs, three rounds, seven coordinator runs and one lens run replayed.
The harness reproduces a review at the original's cost and time, scores
it in seconds, and already yielded: one protocol change to test (safety
candidates are never downgraded at synthesis without a probe), one
round-1 observation for item 13, two candidate escaped findings for
adjudication (#752 regex copies; #752 EPERM liveness), and a measured
reviewer weakness (2 of 4 replay coordinators self-checked until told
otherwise). The next replays are the fix-check snapshots in 4.3, and then
any variant of items 13 to 18.
