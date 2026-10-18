---
name: audit-tests
description: Weekly routine — have a cheap model read the test files main changed since the last run for tests that repeat another's claim, test only a log line, should be one table, or cannot fail for the reason their title gives (testing rules 7 to 10); have a stronger model verify each finding against the code; apply the confirmed ones and land one tests-only PR through the reviews and the merge gate. Use when a Claude Code routine or the user says "audit tests".
model: sonnet
effort: medium
---

# Audit tests

Rules: `docs/internal/agent-rules/testing.md`, `toolchain.md`, and
`delivery.md` rules 14 and 15. You are the author of this PR: there is no
issue and no implementer.

## 1. Workspace and list

```bash
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow
git fetch -q origin
dir=$(.agents/scripts/worktree.sh chore/audit-tests-$(date +%F)) && cd "$dir"
base=$(git log -1 --format=%H --grep='^test(audit):' origin/main)
[ -n "$base" ] || base=$(git rev-list -1 --before='7 days ago' origin/main)
git diff --name-only "$base" HEAD -- '*.test.ts' '*.test.tsx' > <scratch>/files.txt
```

Drop files that no longer exist. Keep at most 15, the most changed lines
first, and name the rest in the PR body as left for the next run. An empty
list: report `PR: none` and stop.

## 2. Scan (cheap model)

Group the files so each group is about 3,000 lines, related files
together. Start one Agent per group in one message: `model: "haiku"`,
`subagent_type: "general-purpose"`, `run_in_background: false`, with the
worktree, its files, an output path `<scratch>/scan-<n>.jsonl`, and the
brief `.agents/briefs/audit-tests-scan.md`. Concatenate the outputs into
`<scratch>/scan.jsonl`. Keep each scan coverage report. Zero candidates
is not permission to skip the clean sample below.

## 3. Verify (stronger model)

Split `scan.jsonl` into at most 60 lines per verifier. Start one Agent per
part: `model: "sonnet"`, `subagent_type: "general-purpose"`,
`run_in_background: false`, with the worktree, its part, an output path
`<scratch>/verdict-<n>.jsonl`, and the brief
`.agents/briefs/audit-tests-verify.md`. Only the verdicts that change
something (`DELETE`, `MERGE`, `TABLE`, `FIX`) go on.

### Sample clean results

Before applying findings, Sonnet independently scans up to three files that
Haiku marked fully scanned with no candidates (all if fewer). Sort eligible
paths, rotate the starting index by ISO week modulo their count, and record
the selected paths and commit. This runs even when the entire scan found
zero candidates. Give Sonnet the scan brief and files, without Haiku's
conclusions. Verify any new candidates using the verifier brief before fixes.
If a sample reveals a confirmed miss, scan every remaining clean file with
Sonnet this run. Incomplete Haiku coverage is not clean: finish it with
Sonnet or report the omitted scope and do not call the audit complete.

Record scanned/omitted files, sampled files, Haiku candidate count, confirmed
candidates and confirmed sample misses separately in the PR or final report.
No eligible clean files: record zero sampled with the reason. Only after
verification and sampling yield no actionable findings report `PR: none`.
These are measured misses in the sample, not a repository-wide recall rate.

## 4. Apply

Give each test file to one applier: a verdict that moves a case between two
files goes to the applier that owns both. Start one Agent per group of
files with `model: "sonnet"`, `subagent_type: "general-purpose"`,
`run_in_background: false`, its verdicts and files, and the brief
`.agents/briefs/audit-tests-apply.md`. Appliers break source to prove each
new assertion, so start them one after another when two of them cover the
same source file.

Then `git status`: only test files changed. Run each changed test file once
more, then:

```bash
git add -A && git commit -m "test(audit): <n> weak tests fixed, <m> fewer tests, since <short base>"
git push -u origin HEAD
gh api -X POST repos/<owner>/<repo>/pulls -f title="test(audit): <n> weak tests fixed, <m> fewer tests, since <short base>" \
  -f head="$(git branch --show-current)" -f base=main -F draft=true -F body=@<scratch>/pr.md -q .number
```

The body: `<base>..<head>`, the files read and those left for the next
run, the test count before and after per file, one line per applied verdict
with its reason, the findings the verifiers rejected (count per sign), any
`bugs:` line an applier reported, and `*Written by an agent.*`.

## 5. Review and merge

As `harden-tests` step 4: `reviewer` with the PR number, round 1; fix each
Fix line yourself, tests only; the `## Review` section with `Spec review:
skipped.`; `gh pr ready`; `.agents/scripts/merge-pr.sh <M>`. A `bugs:` line
from an applier is a real defect: leave the PR open and report it.

## Report

```
Routine: audit-tests  Base: <short sha>  Files: <read>/<changed>  Findings: <scan> scanned, <kept> verified
PR: #M merged | #M open (<why>) | none
```

Review follow-up uses `docs/internal/REVIEW.md`: pass the previous SHA and
resolution ledger, classify actual impacts and recheck changed assertions
with code/tests and changed claims with claims. Record all invocations and
Assessment. The round cap parks unresolved blocking or incomplete work;
tests/comments are not blanket exemptions from recheck.
