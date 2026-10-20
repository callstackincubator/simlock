---
name: calibrate-reviews
description: Weekly routine — regenerate .agents/briefs/calibration.md from the last four weeks of rejected review findings and land it as one docs-only PR. Use when a routine or the user says "calibrate reviews".
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

The body: how many rejected findings the four weeks had, how many lines the
brief lists per review, and `*Written by an agent.*`.

## 2. Review and merge

As `toolchain.md` "Routines" says. The kind is `docs-only`, so only the
claims review runs.

## Report

```
Routine: calibrate-reviews  Rejected: <n> in four weeks
PR: #M merged | #M open (<why>) | none
```

Calibration uses canonical incorrect findings, excluding duplicate,
intentional and nonblocking outcomes. Preserve unknown legacy outcomes;
do not infer false positives from raised-minus-fixed. For model promotion,
use the replay/shadow protocol and the run measurement in
`docs/internal/REVIEW.md`, not this rejection sample alone.
