---
name: calibrate-reviews
description: Weekly routine — regenerate .agents/briefs/calibration.md, the findings reviews raised and the verification rejected in the last four weeks, which every reviewer reads before its diff, and land it as one docs-only PR through the reviews and the merge gate. Use when a Claude Code routine or the user says "calibrate reviews".
model: sonnet
effort: low
---

# Calibrate reviews

Rules: `docs/internal/agent-rules/delivery.md` rules 14 and 15. You are
the author of this PR: there is no issue and no implementer.

## 1. Regenerate

```bash
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow
git fetch -q origin
dir=$(.agents/scripts/worktree.sh chore/calibrate-reviews-$(date +%F)) && cd "$dir"
node .agents/scripts/delivery-stats.mjs --calibration > .agents/briefs/calibration.md
git diff --quiet -- .agents/briefs/calibration.md && echo unchanged
```

`unchanged`: report `PR: none` and stop. Otherwise:

```bash
git add .agents/briefs/calibration.md
git commit -m "chore(reviews): calibration brief for the four weeks to $(date +%F)"
git push -u origin HEAD
gh api -X POST repos/<owner>/<repo>/pulls -f title="chore(reviews): calibration brief for the four weeks to $(date +%F)" \
  -f head="$(git branch --show-current)" -f base=main -F draft=true -F body=@<scratch>/pr.md -q .number
```

The body: how many rejected findings the four weeks had and how many lines
the brief lists per review, the `## Review` section exactly as the deliver
skill's step 4 shapes it with `Spec review: skipped. Code review: skipped.`,
and `*Written by an agent.*`.

## 2. Review and merge

`reviewer` with the PR number, round 1: its kind is `docs-only`, so only the
claims review runs. Fix each Fix line yourself, then `gh pr ready <M>` (in
a cloud session it fails with a 403 naming the proxy's ready-for-review
route: call that route) and `.agents/scripts/merge-pr.sh <M>`. Anything but a merge: leave the PR open
and report.

## Report

```
Routine: calibrate-reviews  Rejected: <n> in four weeks
PR: #M merged | #M open (<why>) | none
```
