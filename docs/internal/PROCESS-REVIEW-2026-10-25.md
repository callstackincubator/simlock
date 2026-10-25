# Process review, 2026-10-25

Where the time went in every `deliver` and `spec-session` run on this
machine since #904 merged (2026-10-23 11:00), what each stage spends it
on, and what to change. Every number comes from the transcripts; every
proposal names the number it is judged by. An adversary pass (section 7)
ran on the first draft; the proposals below are what survived it, with
the corrections it forced.

## 1. Scope and method

Runs read: `deliver` for #905 (console data loading, 8 PRs), #906
(device stream, 5 PRs), #961 (per-platform lease limit, 1 PR), #962
(stopped at once), bugs #817 and #865; `spec-session` for #147, #946,
#947, #949, #950. That is 16 PRs, 160 tagged sub-agent runs (872
agent-minutes), 6 orchestrator transcripts, 5 spec sessions with 65
helper runs.

Tooling: a transcript-to-timeline script (elapsed minute, gap, tool call,
duration, truncated text) over every main and `subagents/*.jsonl` file;
deterministic aggregates over the timelines (tool time by command class,
sub-agents running per minute, per-stage wall); one Haiku agent per task
cutting each timeline into labelled segments and reporting facts anchored
to minutes; one Fable agent attacking the draft. The grouping and the
judgement are mine. Scripts, reports and the adversary's report sit under
`/tmp/dlv` on this machine; the timeline script is worth promoting to
`.agents/scripts/` (item 22).

## 2. Where the time went

### 2.1 Runs

| Run  | Wall    | Sub-agents running | No agent running | Of which human idle | Of which CI gate | Outcome                                       |
| ---- | ------- | ------------------ | ---------------- | ------------------- | ---------------- | --------------------------------------------- |
| #905 | 563 min | 343 min            | 221 min (39%)    | 62 min              | 91 min           | 8 PRs merged at 405 min; then #906's #911     |
| #906 | 384 min | 166 min            | 218 min (57%)    | 185 min             | 2 min            | parked on disk at 137 min; 5 PRs merged later |
| #961 | 66 min  | 51 min             | 15 min           | 0                   | 9 min            | 1 PR merged                                   |
| #817 | 60 min  | 15 min             | 45 min           | 15 min              | 26 min, killed   | PR #953 merged by hand                        |
| #865 | 20 min  | 4 min              | 16 min           | 15 min              | 0                | no PR: already fixed by #883                  |
| #962 | 1 min   | 0                  | 1 min            | 0                   | 0                | waited on #966 of another feature             |

"Human idle" is time with no tool call and no sub-agent while a person was
needed. It splits: 160 min after #906 stopped on disk (the maintainer was
away from both sessions for three hours; no message in #905 either from
12:15Z to 16:44Z), 25 min after the hand purge, 21 min after #905 stopped
on a cross-feature dependency (the maintainer came back unprompted), 41
min after #905's final merge with nothing waiting, 30 min across the two
bug runs waiting for a label. All four `PushNotification` calls answered
`Mobile push not sent (Remote Control inactive)`.

The gate: #905 ran `merge-pr.sh` six times and merged on the fourth; two
failures were Console shards cancelled at CI's 15-minute job limit, two
were flaky tests, one a merge conflict after another feature landed. CI
runs take 6 to 19 min normally, with 61-minute outliers on queued
runners. Console shard 1 takes 9 min on every run; shards 2 to 4 take 2 to
3 (section 3.5, O2).

### 2.2 Stages, all six runs

| Stage              | Runs | Agent-min | Avg  | Of which model | Of which Bash |
| ------------------ | ---- | --------- | ---- | -------------- | ------------- |
| build              | 14   | 281       | 20.0 | 102            | 163           |
| review coordinator | 35   | 152       | 4.3  | 26             | 26            |
| audit              | 13   | 142       | 10.9 | 25             | 117           |
| fix                | 27   | 138       | 5.1  | 31             | 105           |
| code lens (both)   | 17   | 87        | 5.1  | 63             | 25            |
| claims lens        | 19   | 17        | 0.9  | 12             | 5             |
| spec lens          | 17   | 15        | 0.9  | 15             | 0             |
| tests lens         | 5    | 13        | 2.5  | 11             | 2             |
| hardware           | 3    | 3         | 0.9  | 1              | 2             |

Model time and tool time are each about half of the 872 minutes. Tool
time by command, sub-agents and orchestrators together (519 min; about
half sits in compound commands the classifier calls `other` or `write`,
where edits, probes and test runs share one call):

| Command class                                     | Calls | Minutes | Note                                             |
| ------------------------------------------------- | ----- | ------- | ------------------------------------------------ |
| vitest, test:changed, test:e2e                    | 168   | 101     | 36 s average; `test:changed` picked 176 files for `ui/` edits |
| local console lane (`test:console`)               | 51    | 86      | whole lane 24 runs, 41 min; targeted 33 runs, 44 min; each run rebuilds first (about 20 s) |
| git commit (hooks)                                | 125   | 34      | 16 s average; the hooks alone take 3 to 6 s      |
| stack-sync, merge-pr (orchestrator)               | 32    | 24      | the gate's own wait runs in the background       |
| PR and issue reads and writes                     | 116   | 17      | mostly the orchestrator's body edits             |
| review-inputs.sh                                  | 49    | 11      | 13 s average                                     |
| ci-triage, ci-failures, gh run view               | 74    | 10      |                                                  |
| git push (hooks)                                  | 20    | 6       |                                                  |
| worktree.sh                                       | 54    | 5       | 6 s average: clonefile plus offline pnpm         |

### 2.3 Per PR

| Issue | PR  | Changed lines | Files | Build | Audit | Fix  | Review (coord + lenses) | Total | Ledger findings fixed          |
| ----- | --- | ------------- | ----- | ----- | ----- | ---- | ----------------------- | ----- | ------------------------------ |
| 910   | 928 | 2221          | 52    | 38.1  | 15.2  | 25.9 | 47.6                    | 127   | 1 (testing 3)                  |
| 915   | 937 | 2240          | 57    | 38.4  | 24.6  | 6.6  | 25.7                    | 95    | 2 (manual stale, acceptance)   |
| 911   | 943 | 792           | 29    | 46.7  | 14.7  | 2.1  | 23.2                    | 87    | 1 (behaviour)                  |
| 909   | 923 | 989           | 31    | 19.5  | 5.8   | 30.5 | 26.5                    | 85    | 1 (testing 10); slow lane 29.5 |
| 912   | 924 | 300           | 17    | 34.8  | 16.8  | 8.4  | 24.2                    | 84    | 2 (testing 10, false comment)  |
| 916   | 927 | 620           | 18    | 13.7  | 8.0   | 40.3 | 18.5                    | 81    | 2 (behaviour)                  |
| 914   | 926 | 1339          | 28    | 30.3  | 7.3   | 8.2  | 28.6                    | 74    | 4 (2 behaviour, 2 claims)      |
| 966   | 975 | 1367          | 49    | 22.1  | 15.1  | 5.7  | 15.3                    | 58    | 1 (comment)                    |
| 918   | 940 | 146           | 3     | 15.1  | 20.1  | 1.0  | 5.9                     | 42    | 0                              |
| 913   | 922 | 356           | 18    | 12.6  | 4.6   | 4.0  | 13.3                    | 35    | 2 (manual, comment)            |
| 917   | 939 | 293           | 5     | 4.8   | 5.9   | 1.4  | 12.9                    | 25    | 3 (testing 3 twice, debug output) |
| 919   | 920 | 80            | 4     | 2.4   | 1.9   | 1.6  | 15.4                    | 21    | 0                              |
| 817   | 953 | 37            | 4     | 2.1   | 1.8   | 1.1  | 10.9                    | 16    | 1 (docs example)               |
| 886   | 938 | 3             | 1     | 0     | 0     | 0    | 10.3                    | 14    | 0                              |
| 905   | 907 | 161           | 3     | ADR   | ADR   | 0.6  | 11.0                    | 12    | 1 (ADR text)                   |
| 906   | 908 | 83            | 2     | ADR   | ADR   | 0.8  | 7.0                     | 8     | 0                              |

The five PRs under 150 changed lines cost 51 agent-minutes of review and
post-review fixes plus 24 of audit (20 of them #940's console-lane audit)
for one fixed finding, a docs example. The eight under 300 lines cost 105
plus 46 for seven: three text fixes, three test-logic or coverage fixes
(`testing 3` twice, `testing 10`), one debug line; five of the seven were
the Opus code lens's. In this sample no behaviour finding sits under 600
changed lines; in the previous review's sample #751 (194 lines) carried a
safety finding and #753 (176 lines) a behaviour one. Size does not predict
risk; path does.

### 2.4 Spec sessions

| Session | Agent time | Human answering | Interview rounds | Checker launches | Checker wall | Blocking / notes | Fix cycles |
| ------- | ---------- | --------------- | ---------------- | ---------------- | ------------ | ---------------- | ---------- |
| #147    | 30 min     | 9 min           | 4 (10 questions) | 4 + 4 rechecks   | 31 min       | 23 / 9           | 5          |
| #947    | 25 min     | 12 min          | 1 (3)            | 3 + 2            | 23 min       | 5 / 11 (1 task)  | 3          |
| #949    | 28 min     | 10 min          | 3 (8)            | 4 + 4            | 34 min       | 14 / 15          | 3          |
| #950    | 47 min     | 5 min           | 4 (10)           | 7 + 3            | 42 min       | 19 / 18          | 3          |
| #946    | 49 min     | 21 min          | 2 (5)            | 3 + 3            | 45 min       | 10 / 9 (1 task)  | 3          |

Overnight approval waits (#946: 550 min; #949: 625 min inside the
delivery that followed) are the maintainer's time. Explorers ran 1 to 5
per session, 2 to 16 min, beside the interview; two never reported back
(#949, #946), one was interrupted (#947).

## 3. Findings by stage

Classes: **expected** (the cost of a step we want), **improvable** (a
wanted step done dearer than needed), **unexpected** (cost no rule asked
for), **problem** (a defect in the process or its tools).

### 3.1 Specification

- **S1 — Checkers are half the session (improvable).** Checker wall is 23
  to 45 min of sessions whose agent time is 25 to 49 min. Rounds run in
  parallel (5 to 10 min each) and every session ran 3 to 5 of them. The
  cost is the cycle count (5 in #147), and the previous review's finding
  that half of round-2 findings sit in round-1 fixes still holds. For a
  one-task feature (#947, #946) the feature checker's cross-task
  categories (overlap, shared values, contradiction between tasks) have
  no input, though its completion-condition and ADR-fact checks do.
- **S2 — Round 0 pays (expected).** #947's round 0 merged two tasks into
  one before they were written; #950's round 1 reopened a decision
  (`Explain`, then a private profile file) and rewrote the ADR and three
  bodies: 4.5 min of drafting repeated. Round 0 exists for that case.
- **S3 — Body editing by hand (improvable).** Every session and every
  delivery edits issue bodies the same way: `gh issue view --json body`,
  python `replace` with `assert count == 1`, `gh issue edit --body-file`.
  #950 had two Write refusals and #949 an AssertionError on it; #905's
  orchestrator did it 6 times, #961's twice. A minute per session, and the
  place where the one-label and footer rules could be mechanical.
- **S4 — ADR number race (expected, rare).** #949 drafted ADR 0046, found
  #954 held it, renumbered (0.7 min). Five sessions were started in two
  batches the same evening; a branch push reserves nothing because the
  branch is named for the feature, not the ADR.
- **S5 — Helpers that never report (problem, small).** Two background
  explorers' results never reached the session (#949, #946); the session
  read the sources itself.
- **S6 — Environment gaps (unexpected, small).** `simlock` not on PATH
  (#147 ran an old dist build for a Facts row), `prettier` not found
  (#949).
- **S7 — Human answering is 5 to 21 min (expected).** Rounds are few and
  questions carry recommendations.
- **S8 — Dependency width is set here and nothing reports it (problem).**
  #905's seven tasks formed a line (913, 914, 915, 916, 917, 918), so two
  tasks were in flight for 72 of 343 busy minutes despite "up to two".
  #906 waited on #909's review before #910 could start. The orchestrator
  cannot widen a chain later; the spec session never saw its length.

### 3.2 Implementation: build

- **B1 — A healthy build is 85% engineering (expected).** #966's
  22-minute build: 51 segments, 35 commits, 9 pushes, 12.7% of wall on
  rules, hooks and PR bookkeeping. Seven of 35 commits bounced on a hook
  (3 typecheck, 4 comment lint) and were fixed in the next call. Hooks
  run 3 to 6 s; the 16 s average commit is hooks plus git. 125 commits
  cost 34 minutes: the price of the red-green record `review-inputs.sh`
  reads (`tests-after-red.patch`).
- **B2 — The local console lane (unexpected).** 51 `test:console` runs
  cost 86 agent-minutes: 24 whole-lane runs (41 min) and 33 targeted runs
  (44 min). Toolchain allows the lane when the diff touches `ui/`; #905
  was all UI. The whole-lane runs are the waste: #915's audit started the
  lane in the background and waited 10.3 min through a polling loop to
  the 600 s tool limit; #918's audit spent 17.4 of 20 min in console
  runs; #910's build 6.7 min. CI runs the same lane on every push. The
  targeted runs are the brief's red-green and stay. Every run rebuilds
  first (`pnpm run build && build:e2e`, about 20 s, `swift build` on a
  Mac): 51 runs, about 17 min of rebuilding unchanged code.
- **B3 — Blocking commands and polling (problem).** The chain has four
  links. (1) The Bash tool's default timeout is 120 s and 59% of test
  commands in stage agents set none (5,482 of 9,354 across this
  machine's worktree sessions); a two-minute test run is therefore
  "moved to the background" (6 such moves in these runs, 3 more at 600
  s). (2) A bare `sleep N` is refused by the harness with the advice to
  use Monitor or `run_in_background`; stage agents have no Monitor tool,
  so they take the second route or write `until ... pgrep` loops (28
  loop or sleep calls, 48 min, 13 of them the slow-lane wait rule 16
  designs). (3) A loop runs to the 600 s limit and is itself moved to
  the background. (4) A sub-agent with a live background job is not
  finished: its completion reaches the orchestrator only when the job
  ends or hits its 30-minute cap. #911's build shows all four: a
  `cat > /tmp/x` with no input hung the push for 600 s, the push was
  redone, the agent wrote its report at 30.8 min, and the orchestrator
  heard from it at 46.5 when the orphaned job's 30-minute cap fired:
  26 of that build's 47 minutes. Stage agents lost about 36 min to this
  chain; #906's hand-requested purge another 10.
- **B4 — Edits through Bash (unexpected, harness-driven, small).**
  Deliver sub-agents made 274 edits with python heredocs, `perl -pi` or
  `sed -i`, and 3 with the Edit tool. Failed calls across 145 runs: 60,
  226 s in all (`sed -i` without `''`, `sed: bad flag`, swallowed stdin).
  Bypass-permissions mode tells agents to prefer Bash; an allowlist
  instead would prompt inside background agents and stall the run.
- **B5 — `test:changed` is not "run its file" (unexpected).** 59 test
  commands in builds averaged 40 s; `pnpm test:changed` selected 176
  files for a `ui/` edit. The brief says to run the cycle's file (5 to
  10 s). Either the brief is not followed or the import graph makes every
  `ui/` edit touch everything; the number to read is files per
  `test:changed` call.

### 3.3 Implementation: audit and fix

- **A1 — The audit is test execution (expected, bounded by B2).** 10.9
  min average, 117 of 142 minutes in tools: mutation probes and Project
  checks. Audits found 1 to 11 test fixes on every code PR, 3 spec needs
  on #966, 6 fixes and a spec need on #913. `report-guard` sent 4 audits
  back to probe the rest, each under a minute.
- **A2 — Fix runs are cheap when they are fixes (expected).** 16 of 27
  under 2 min. The long ones were not findings: #916 twice (14.5 and
  18.5 min) on a toast test that hangs under load and a stack merge;
  #909's 29.5 min was the slow lane (two test-code bugs, a lane run
  each); #910's 15.7 min a hook replacement.
- **A3 — Flaky tests are the top gate killer (problem).** #916's toast
  test cost two fix runs (33 min) and two gate cycles (33 min);
  `screen.spec` failed a gate; `actions.spec.ts:166` (the disk-99% case)
  cost three local whole-lane runs in #912, one in #914, a bug (#886), a
  PR (#938) and its 14-min review. About 100 agent-plus-gate minutes
  across #905 and #906. `ci-triage` classifies; nothing quarantines.
- **A4 — Spec needs decided in delivery (expected).** 15 decisions in
  #905 and 1 in #961, each folded into the body with a `Decision taken`
  comment; the maintainer accepted all at 446 min. About a minute each.
- **A5 — Round 2 for a fix's own side effect (improvable).** #924's round
  2 found a false `why:` comment the round-1 fix had introduced;
  `implement-fix.md` step 2 already tells the fix run to check its hunks.
  Five PRs had three checks; 35 coordinator runs for 16 PRs.

### 3.4 Review

- **R1 — The review floor does not scale down (improvable, bounded).** A
  round is a Sonnet coordinator (4.3 min, half of it waiting), a spec
  lens (0.9), a claims lens (0.9), an Opus code lens (5.1), then a fix
  and a fix-check. #938 (3 lines) got three lenses, 10.3 min, 0 findings;
  #920 (80 lines) 15.4 min, 0 findings. But the five smallest PRs
  together cost 75 agent-minutes of audit and review, 20 of them the
  console lane; a lighter path would recover 10 to 15 of the rest, and
  five of the seven findings on PRs under 300 lines were the Opus lens's.
  The floor is real and small; the lenses earn their keep by path, not
  size.
- **R2 — Coordinator overhead (improvable).** A fifth of a coordinator's
  time is `review-inputs.sh`, ledger, findings file and report. The
  orchestrator posts the `## Review ledger` comment by hand (11 times in
  #905, SHAs typed from memory) and twice ran `pr-body-check.mjs` before
  the ledger existed (#817, #961), a failed call and a retry each.
- **R3 — Fix-checks are already cheap (expected).** Mechanical and
  claims-only fix-checks ran 0.4 to 1.4 min with no lens. #975's one
  finding (a comment) cost 0.5 min of fix and 0.4 min of check.
- **R4 — Lenses read what they were given (expected).** Code lenses spend
  half their time reading code and a fifth verifying; a tenth is rule
  files already in the prompt, which they cite.

### 3.5 Orchestration and the gate

- **O1 — The notification channel is broken (problem).** Every run's push
  failed. The idle it explains is the 21 and 25 minute returns and part
  of the 160; the three-hour absence it would not have cut, and the 41
  min after the final merge had nothing waiting. Still the one channel a
  stopped run has, and it is off.
- **O2 — Gates fail more than they merge (problem).** Five of six gate
  runs in #905 failed: two Console shards cancelled at CI's 15-minute
  job limit (`ci.yml:192`), two flaky tests, one conflict; 91 min of
  gate waiting, 22% of the 405 minutes to the merge. #906's stack was
  merged by hand after a sixth gate was killed. Console shard 1 runs 9
  min on every `main` run while shards 2 to 4 run 2 to 3: `--shard` splits
  spec files in order and the heavy files sit first, so the lane's wall
  is one shard's, and that shard is the one the 15-minute limit cancels
  on a slow runner.
- **O3 — Hand-built bookkeeping (improvable).** #905's orchestrator made
  97 bookkeeping calls (37 min of tool time plus the model time to write
  them): 13 PR body writes, 11 ledger comments, 44 head/base SHA checks,
  27 ci-triage-plus-head calls, 17 stack-syncs, 10 reads of a background
  gate's output, 13 `gh run view --log-failed` by hand. Between a
  completion and the next launch it takes 0.3 to 0.9 min when it only
  launches, 3 to 6 min when it also edits. Three times it read a CI
  result older than the head and reasoned it out (`ci-triage` reads the
  newest finished run by design).
- **O4 — Cross-feature dependencies stop runs (problem).** #905 stopped
  because #915 depended on #912 of feature #906 (a loop the maintainer
  cut by hand, 28 min); #962 stopped in one minute because #968 depends
  on #966 of #961. Correct behaviour, no follow-through.
- **O5 — Bugs through the front door (improvable).** #817 and #865 were
  `bug:new`; the orchestrator stopped, the maintainer typed "run
  triage", read the report, typed "make it ready": 20 min before the
  first implementer, most of it a person reading and deciding, as rule 8
  intends. #865's triage found the bug already fixed by #883.

### 3.6 Environment: worktrees, disk, hooks

- **E1 — Creation is fast; nothing removes (problem, hygiene).**
  `worktree.sh` costs 6 s on average (clonefile of `node_modules`,
  offline pnpm relink). No script removes one: 196 had accumulated by
  2026-10-23 and the orchestrator purged them by hand in 18.8 min through
  a 600 s timeout, freeing 21.7 GiB (113 MB each). Today 31 remain besides
  `main`; at least 10 are removable (2 task worktrees whose PRs merged, 5
  detached review probes the reviewer was told to remove, 3 T3 worktrees
  of finished chores), about 1.1 GiB. Branch tips are never ancestors of
  `main` (squash merges), so "merged" must be read from the PR.
- **E2 — Disk is not worktrees (problem).** The data volume was at 99%
  (12.9 GiB free) when the slow lane needed 15 and #909 parked; it is at
  98% again today (22 GiB free). The weight is simulators (30 GB in
  CoreSimulator), the pnpm store (48 GB), `.android` (29 GB). Worktree GC
  keeps the count sane; a disk budget needs `pnpm store prune` and old
  runtime removal, and a check before a run starts.
- **E3 — Umbrella issues stay open (expected by rule, unwanted).**
  Until this review, delivery rule 9 said the maintainer closes the
  feature; the deliver skill posted a run summary and stopped. All eight features delivered since
  2026-10-22 were closed by hand, three together in one session on
  2026-10-24. The rule 10 ADR status flip is manual too. The last PR's
  body already walks the completion conditions (rule 9), so the check the
  maintainer makes is the one the reviewer made.
- **E4 — Hooks are cheap (expected).** Typecheck 3 s, depcruise 4 s,
  oxlint 2.4 s, fallow 2.8 s, typecheck:e2e 6.3 s, comment lint 0.1 s.

## 4. What we change

Grouped by stage; each item names its mechanism and the number it is
judged by. Savings are per run of the kind named, after the adversary's
corrections (section 7). Dropped first-draft items are listed in 4.6.

### 4.1 CI and the gate (zero agent minutes; the gate was 22% of #905)

1. **Balance the Console shards and lift the shard limit.** Playwright
   splits whole files in alphabetical order: shard 1 holds
   `actions.spec.ts` (16 tests, the slow polls), `activity`, `inbox`,
   `layout`, `big-fleet` and `daemon-start-failure`, 54 tests; shard 4
   holds `workers` and `long-lists`, 46; shards 2 and 3 run in 2 to 3
   min. Shard by test (`fullyParallel: true` for the console project) or
   by a file list sorted by measured duration, and set `timeout-minutes`
   so the slowest shard on a slow runner fits (20). Mechanism: `ci.yml`,
   `playwright.config.ts`. Saving: the lane's wall from 9 min to about 4
   on every CI run, and the two cancellation gate failures in #905 (about
   30 min of gate plus a hand merge of #906's stack). Measure: Console
   shard max minutes per run; gates failed on `cancel`.
2. **Quarantine a flaky test on the second `unknown`.** When
   `ci-triage.mjs` classes the same test `unknown` twice in one delivery,
   the orchestrator opens the `flaky-test` issue and skips it (the
   mechanism testing rule 5 already defines) instead of a third CI cycle
   or a fix run. Mechanism: `ci-triage.mjs` output plus one skill line.
   Saving: #916's toast test alone cost 33 min of fixes and 33 of gates.
   Measure: fix runs that changed no production code; gate cycles per PR.
3. **`merge-pr.sh` reports progress** (one line per poll: pending checks
   and minutes), so a 32-minute gate reads as a status and "what's the
   status?" has an answer. Mechanism: script. Saving: nil in minutes.

### 4.2 Specification

4. **The feature checker on a one-task feature runs only its live
   categories** (completion conditions, ADR facts), not overlap, shared
   values or cross-task contradiction. Mechanism: `spec-checker.md` scope
   text. Saving: a few minutes in 2 of 5 sessions. Measure: checker
   minutes per one-task session.
5. **`issue-body.sh <n> set-section <name> <file>` and
   `issue-body.sh <n> replace <old> <new>`:** read, edit, assert one
   match, keep the footer, keep exactly one state label, write. Used by
   the spec session, the orchestrator's decisions and fold-ins.
   Mechanism: script. Saving: about a minute per session and decision,
   and the three assertion or refusal retries. Measure: hand
   `gh issue edit --body-file` calls per session.
6. **A `chain` category in the feature check:** the longest Depends on
   path against the task count, in the report and the approval summary,
   so the maintainer sees "7 tasks, chain of 6" before approving.
   Mechanism: `spec-checker.md`, skill step 9. Saving: none by itself;
   #905 would have run two tasks at a time for most of its 343 busy
   minutes if the chain had been 3. Measure: in-flight tasks per busy
   minute in the next feature runs.
7. **A `depends-outside` finding** when a task's Depends on names an
   open issue of another feature, so the maintainer decides at spec time
   whether to wait or cut. Mechanism: `spec-checker.md` category.
   Saving: the #905 loop (28 min) and #962's one-minute stop.
8. **The approval summary ends with the command to run next**
   (`/deliver <N>` in a new session), and the end-of-run summary of a
   delivery that waits on another feature names the issue to watch
   (`Waiting: #968 — on #966`). Mechanism: text in two skills. Saving: a
   human round trip per session (#949 and #950 both typed the command a
   minute later).

### 4.3 Implementation

9. **Never the whole console lane locally, never in the background.** A
   build or fix runs only the spec files it changed, Chromium only, in
   the foreground under `timeout 550`; an audit probes the same way; the
   full lane is CI's. Mechanism: `toolchain.md` "Tests agents run" row
   (1) and the three briefs. Saving: the 24 whole-lane runs, 41
   agent-minutes across these runs, about half on the critical path;
   #918's audit and #915's audit lose 10 to 17 min each. Measure:
   `test:console` runs without a file argument (today 24).
10. **`pnpm test:console:fast`** skips `pnpm run build` and `build:e2e`
    when `dist/` is newer than every file under `src/`, `ui/`,
    `vendor/` and `e2e/`. Measured warm with nothing changed: the full
    build is 13 s (daemon 4.5, ui 4.3, capture's Swift step cached) and
    20 s when the Swift step runs; `test:e2e` pays the same build on
    each of its 17 runs. No task runner is installed (no turbo, nx or
    wireit); turbo would give the same skip through an input-hash cache
    and could share it across worktrees, at the price of a dependency and
    its config, so the mtime check comes first and turbo is the follow-up
    if cold builds in fresh worktrees (about 25 s each, 54 worktrees
    created here) turn out to matter. Mechanism: package.json script,
    toolchain row. Saving: 13 to 20 s on each of 68 console and e2e runs,
    about 17 min across these runs. Measure: seconds per targeted console
    run (today about 80, of which 13 to 20 is the build).
11. **Break the polling chain at its first link.** `tool-guard.mjs`
    refuses, for a stage agent, (a) a Bash call that runs a test runner
    (`vitest`, `test:*`, `playwright`, `slow-e2e.sh` excepted) with no
    `timeout` parameter or one under 300000, telling it to pass
    `timeout: 600000`; (b) `run_in_background: true` and a trailing `&`,
    except for `slow-e2e.sh`, which is detached by design and waited on
    through its `.exit` file (`hardware-verifier.md`,
    `implement-hardware-fix.md`); (c) an `until`/`while` loop around
    `pgrep` or a file test outside those two agents; (d) a bare
    `cat > file` with no heredoc or input. The briefs say the same in
    one line: foreground, `timeout` set, nothing left running. Mechanism:
    guard rules plus a brief line. Saving: about 36 min of stage-agent
    wall across these runs (#911's build 26, #915's audit 10), all on the
    critical path, and the orphaned-job stall that holds a finished
    agent's report for up to 30 min. Measure: tool calls moved to the
    background (9 here); polling calls outside the slow-lane agents (15);
    sub-agents whose report reached the orchestrator more than a minute
    after their last tool call.
12. **Edit with the Edit tool.** One line in the implementer and lens
    agent files. Mechanism: agent files. Saving: the 60 failed calls (4
    min) and reviewer context; small. Measure: Bash edits per build.
13. **`test:changed` for `ui/` edits is measured, then fixed in the
    script.** Count files per `test:changed` call in the next builds; if
    `ui/` edits select the whole suite, the script restricts by project
    or the brief's "run its file" gets a hook that refuses `test:changed`
    before the cycle's own file ran. Mechanism: measurement first.
    Saving: up to 30 of the 39 build minutes spent in test runs in #905.

### 4.4 Review

14. **A fix run ends with the claims check on its own hunks**, as
    `implement-fix.md` step 2 already asks; the fix report names it, and
    a fix-check whose hunks are tests and comments only is then the
    coordinator's mechanical check. Mechanism: enforce the brief's own
    line in `report-guard.mjs` (the fix report carries `claims checked:
    <files>`). Saving: a round on fixes like #924's (its round 2 found
    the false comment the round-1 fix wrote). Measure: round-2 findings
    whose line the round-1 fix added.
15. **`review-ledger.sh <pr> <findings.json> <round>:<sha>...`** posts the
    ledger comment with `review-metrics.mjs` output, then runs
    `pr-body-check.mjs`, in that order. Mechanism: script. Saving: 1 to 2
    min per PR; the two ordering failures. Measure: `pr-body-check`
    failures per run.
16. **`ci-triage.mjs` says when its run is stale** (`stale: run <id> is
    <sha>, head is <sha>`, exit 3) and the skill says what follows: wait
    for the next sub-agent's completion and triage again, never poll.
    Mechanism: script plus one skill line. Saving: three stale reads in
    #905, a minute each and a wrong fix run avoided.
17. **The router, as measurement first.** Build `task-size.mjs <issue>`
    (Tests lines, Modules touched, strict-area paths, contract or event
    changes, ADRs) and give `diff-kind.mjs` a `small` kind (under 150
    changed lines, none in `src/leasing/`, the named `src/core/` files,
    `src/contract/`, or a module whose manual names ownership, deletion,
    persistence, credentials or concurrency). Record both verdicts in the
    PR body for every PR, and route nothing differently yet. Then freeze
    the `small` snapshots and replay them with a single Sonnet run
    (`review-replay.sh --lens`, three runs each) under REVIEW.md's own
    pilot bar: at least 20 snapshots, 10 with known bugs, recall not
    below Opus, no higher clean-PR false-positive rate. Adopt a lighter
    path only on that evidence. Why not now: in this sample `small`
    routes two PRs (#938, #940), the saving is 10 to 15 agent-minutes
    per feature run, and the previous review's #751 (194 lines) carried a
    safety finding the Sonnet coordinators downgraded in replay. The
    router's first use is the other direction: a `risk` verdict that
    forces the Opus code lens and a second tests lens on a small diff in a
    safety path, which REVIEW.md asks for in prose today. Measure: the
    two verdicts per PR against the ledger over the next 20 PRs.

### 4.5 Orchestration and environment

18. **A notification that arrives.** The deliver skill tries
    `PushNotification`, then `osascript -e 'display notification'` on
    macOS, and always writes why the run stopped into the run-summary
    comment. Mechanism: skill step 4. Saving: the 21 and 25 minute
    returns and some of the 160; not the three-hour absence. Measure:
    minutes from a run's last status line to the next human message.
19. **`pr-shas.sh <pr>`** prints base, merge-base, head, mergeable and the
    head's CI state in one call, replacing the 44 SHA checks and 27
    triage-plus-head calls of #905. Mechanism: script. Saving: 3 to 5 min
    of orchestrator turns per feature run; the API time stays.
20. **`/deliver <bug>` on `bug:new` runs the triage and stops with the
    report**, leaving `bug:ready` to the maintainer as rules 1 and 8
    require. Mechanism: skill step 1. Saving: one human round trip per
    bug (the "run triage" message). Measure: messages before the first
    implementer.
21. **`worktree-gc.sh`** removes a worktree when its branch's PR is merged
    or closed (asked from GitHub), or it is detached and older than a day,
    or its branch is a `*-repro`, `rv*` or `review-*` whose commits are on
    origin; never with unpushed commits or tracked changes; prints what it
    kept and why; `--t3` lists T3's worktrees for the person. Runs at the
    end of every `deliver` run and in the reviewer's synthesis step
    (which already says to remove probes). With it, a disk check at run
    start: free GiB against the slow lane's 15, with `pnpm store prune`
    and the simulator runtime list as the named remedies. Mechanism:
    script plus two call sites plus skill step 1. Saving: the 18.8-minute
    hand purge; the disk stall only together with the disk budget.
    Measure: worktrees at run start; free GiB at run start.
22. **Delivery closes the feature; the ADR flip rides in the stack.** When
    the stack merges and the last PR's body walked the completion
    conditions, the orchestrator closes the feature as completed and says
    so in the run summary (rule 9 amended: "the delivering agent closes
    the feature when the last PR's body walks the completion conditions;
    the maintainer may reopen"). The ADR's status line flips to
    _Accepted_ in the last task PR before the gate, as a mechanical hunk
    the fix-check verifies, so nothing is written to `main` outside the
    gate (rule 15) and no ADR-only review runs. Mechanism: rules 9 and
    10 text, deliver skill steps 3 and 4. Saving: one hand session per
    feature (eight since 2026-10-22). Measure: features closed by the
    agent, reopened by the maintainer.
23. **The timeline script joins `.agents/scripts/`** as
    `transcript-timeline.mjs`, with the command classes this review
    lacked (`playwright test`, compound edit-and-run calls), and
    `delivery-stats.mjs` gains: no-agent minutes per run, gate minutes
    and outcomes, `test:console` runs with and without a file, 600 s
    timeouts, Bash edits per build, files per `test:changed` call.
    Mechanism: scripts. Saving: the next review is a command.

### 4.6 Dropped from the first draft

- `adr-next.sh` (a branch named for the feature reserves no number; the
  collision came from five sessions in two batches).
- Replacing bypass mode with an allowlist (prompts inside background
  agents stall an unattended run).
- A Sonnet single-run review path for `small` PRs (item 17 keeps the
  router and defers the path to REVIEW.md's pilot bar).
- `--then-fix` on a bug delivery (it would label `bug:ready` before the
  triage report exists, against rules 1 and 8).
- A `tool-guard` rule requiring the ledger tag on every `Agent` call
  (explorers, triagers and EXPLORATION helpers are legitimately untagged;
  the four untagged runs were bug-triager launches).
- Starting `/deliver` from inside the spec session (it would carry the
  session's context and run from a checkout the skill may refuse).
- An ADR flip as a docs commit on `main` (a write outside the gate).

## 5. What is not changed

- The audit stays a separate fresh agent on every code PR: it found 1 to
  11 test fixes each time and the reviewer still found more.
- The commit-per-test rhythm stays: it is what `tests-after-red.patch`
  reads, at 3 to 6 s of hooks a commit.
- Three independent lenses, the round cap and round 0 of the spec check
  stay; rule 14 is not amended by anything here.
- The targeted console runs in builds stay: they are the brief's red and
  green.

## 6. Order

1. Items 1 and 2 (CI shards, flaky quarantine): no agent minutes, and
   five of six gates failed on exactly these.
2. Items 9, 10, 11 (whole-lane ban, fast console script, polling): about
   90 min of agent time and 36 of critical path across these runs.
3. Items 18, 21 (notification, worktree GC with the disk check): the
   stalls.
4. Items 7, 22, 20 (depends-outside, feature close, bug triage entry):
   the human round trips.
5. Items 15, 16, 19, 5 (the orchestrator's scripts), then 14.
6. Item 17 (router as measurement) and 23 (the stats), so the next review
   measures this one.
7. Items 4, 6, 8, 12, 13, 3 as they come.

## 7. Decisions, 2026-10-25

The maintainer read sections 1 to 6 and the adversary's report and decided
the same day; the first PR carries these:

| Decision                                                        | Implemented as                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turbo, not an mtime check (item 10)                             | `turbo.json` with per-step inputs and outputs; `build`, `build:*`, `test:e2e*`, `test:console`, `typecheck:e2e*` and `openapi` run through `turbo run`. Warm build with nothing changed 15 s to 2 s; one changed `src/` file 5 s.          |
| Whole console lane never by a stage agent (item 9)              | `toolchain.md` row (1) names the changed spec files; `tool-guard.mjs` refuses `test:console` without a spec file. Targeted red-green runs stay.                                                                                            |
| Break the polling chain (item 11)                               | `tool-guard.mjs` refuses, for sub-agents: a test runner without `timeout` of at least 300 s, `run_in_background` and a trailing `&`, a loop that sleeps, a bare `cat > file`; `slow-e2e.sh` and `.exit` waits exempt. One line in each brief. |
| Features close themselves; `bug:triage` goes                    | `issue-state.yml` closes a `feature:planned` issue when its last sub-issue closes and closes its request in the same job; `bug:new` is the triage queue (rules 1, 8, 9; `labels.json`; triage skill and agent; `deliver` step 1).            |
| ADR flip rides in the stack (item 22)                           | `deliver` "Merging the stack": one fix run with `fixes: adr: <nnnn> to Accepted` on the top branch, then the mechanical fix-check; `implement-fix.md` knows the line.                                                                        |
| Orchestrator scripts (items 15, 16, 19, 5, 3)                   | `issue-body.mjs`, `review-ledger.mjs`, `pr-shas.sh`; `ci-triage.mjs` exits 3 on a stale run and prints a failed job's log lines; `merge-pr.sh` prints a progress line per poll. The `deliver` skill names each where it replaces a hand step. |
| Rules that can be checks (item 19)                              | [RULES-TO-LINTS-2026-10-25.md](RULES-TO-LINTS-2026-10-25.md) lists 46 candidates with effort and confidence, and eight drifts a check would have caught; the first conversions follow in their own PR.                                                                                                                              |
| Not yet: the router (17), CI shards and quarantine (1, 2)       | Proposed with numbers; the maintainer decides the CI change separately.                                                                                                                                                                    |

## 8. Adversary review

A Fable agent read the first draft, the data and the rules with the brief
to prove each proposal brings little, overfits these runs, or breaks a
rule. Its report is `/tmp/dlv/ADVERSARY.md`. Verdicts on the first-draft
items and what changed:

| First-draft item                         | Verdict          | Objection, and what this document does                                                                                                  |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| One checker for one-task features        | weaken           | The feature scope still checks completion coverage and ADR facts; and it was 2 of 5 sessions, not 3. Now item 4: drop the categories, keep the run. |
| `issue-body.sh`                          | hold             | Make it enforce the one-label rule. Done (item 5).                                                                                       |
| `adr-next.sh`                            | drop             | The branch is named for the feature, so a push reserves nothing. Dropped.                                                                |
| Approve-and-deliver in the spec session  | weaken           | Step 9 already ends on green; chaining `/deliver` inside the session carries its context. Now item 8: print the command.                 |
| Never the whole console lane; one run per spec file | weaken | "Once per spec file" contradicts red-green (floor is 44 min, not 25); ban the whole lane and the background only. Items 9 and 10.         |
| No background jobs, no polling           | weaken           | The slow lane waits on `.exit` by rule 16; the harness itself backgrounds over-timeout calls; net 36 min, not 55. Item 11 exempts the lane. |
| Edit tool; allowlist instead of bypass   | drop the allowlist | Measured cost 3.8 min of 872; prompts would stall background agents. Item 12 keeps the Edit line.                                       |
| Router with a Sonnet single-run path     | drop as specified | The gate as written routes #938 and #940 only (net 10 to 15 min); #751 (194 lines) carried a safety finding Sonnet downgraded in replay; 8 snapshots with no known bug cannot test it; rule 14 and REVIEW.md's pilot bar are skipped. Item 17 keeps the router as measurement and the path behind the pilot bar. |
| `review-ledger.sh`                       | hold             | Item 15.                                                                                                                                  |
| `ci-triage` stale exit                   | hold             | Say what follows exit 3. Item 16 does.                                                                                                     |
| A notification that arrives              | weaken           | 41 of the 247 min were after the final merge; 160 overlapped a three-hour absence. Item 18 claims the 21 and 25 minute returns only.      |
| Stopped run says when to come back       | weaken           | Keep the `Waiting:` line; drop `schedule_task`. Item 8.                                                                                   |
| `depends-outside` spec check             | hold             | Cheapest real saving (28 min in #905). Item 7.                                                                                             |
| `pr-shas.sh`                             | weaken           | API time stays; the saving is turns, 3 to 5 min. Item 19 says so.                                                                         |
| Gate progress                            | hold             | Nil saving, harmless. Item 3.                                                                                                              |
| `/deliver <bug>` with `--then-fix`       | weaken           | Labels `bug:ready` before the report exists (rules 1, 8). Item 20: triage, then stop.                                                     |
| `worktree-gc.sh`                         | weaken           | 196 worktrees were 113 MB each; today's 10 removable are 1.1 GiB on a volume whose weight is simulators, the pnpm store and `.android`. Item 21 adds the disk budget and drops the disk-stall claim. |
| Delivery closes the feature, flips ADRs on `main` | weaken  | A docs commit on `main` is a write outside the gate (rule 15); an ADR-only PR costs an Opus spec lens (11 min on #907). Item 22 rides the flip in the stack. |
| Ledger-tag guard on `Agent` calls        | weaken           | Untagged helpers are legitimate. Dropped.                                                                                                  |
| Timeline script in the repo              | hold             | Add the missing classes: half the tool time sat unclassified. Item 23.                                                                    |

Levers the adversary found that the first draft missed, now items 1, 2,
6, 10, 13 and 14: the Console shard limit and imbalance, flaky-test
quarantine, dependency chain length at approval, the console rebuild on
every run, `test:changed` selecting 176 files for a `ui/` edit, and a
round 2 spent on a fix's own comment.

Corrections it forced on the numbers: the small-PR set and its findings
(2.3), `test:console` 51 runs and 86 min with the whole-lane/targeted
split (2.2, B2), the polling minutes (B3), the idle decomposition (2.1,
O1), the worktree sizes (E1, E2), the one-task session count (S1), the
unclassified half of the tool-time table (2.2), and that behaviour
findings under 300 lines exist in the previous sample (2.3).
