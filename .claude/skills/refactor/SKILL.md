---
name: refactor
description: Weekly routine — pick one measured refactor target (a file over an ADR cut-off, or a Fallow refactoring or duplication finding), open one refactor:new issue, and when delivery rule 18's three conditions hold set it ready and deliver it. Use when a routine or the user says "refactor routine" or "run the refactor routine".
model: opus
effort: medium
---

# Refactor routine

Rules: `docs/internal/agent-rules/delivery.md` rules 1, 2 and 18, and
`toolchain.md`. You choose the target and write the issue; `deliver` builds
it. One issue per run, for one module.

## 1. Measure

```bash
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow
git fetch -q origin
dir=$(.agents/scripts/worktree.sh --detach origin/main --prepare) && cd "$dir"
```

A target is one of these, and nothing else:

- **A file over a cut-off an accepted ADR sets.** ADR 0063 §3: code over
  1,400 lines, a test file over 2,500, counted with `git ls-files src ui
  e2e scripts .agents/scripts | xargs wc -l`; the files on
  `SHRINK_ONLY` in `src/source-hygiene.test.ts` count too.
- **A Fallow refactoring target**: `pnpm exec fallow health --format json
  --quiet --targets`, the first-ranked target.
- **A Fallow duplication finding**: `pnpm exec fallow dupes --format json
  --quiet`, a clone group of at least the size `.fallowrc.json` reports.

Pick the largest file over its cut-off first, else the first-ranked target,
else the largest clone group. Never a target from reading the code, from
taste, or from IDEAS.md. Nothing measured: report `issue: none` and stop.
Never edit a cut-off, `SHRINK_ONLY`, `.fallowrc.json` or an ADR: a threshold
is the maintainer's.

## 2. Check that nobody is on it

Skip the target, and take the next one, when any of these names one of its
files:

```bash
gh pr list --state open --json number,files --jq '.[] | select(any(.files[]; .path == "<file>")) | .number'
gh issue list --state open --search 'label:bug:ready,task:ready,refactor:ready,refactor:new' --json number,body,assignees
```

an open PR's files; a claimed issue's body; a `task:ready` task's
`### Modules touched`; an open `refactor:new` or `refactor:ready` issue's
Target shape. Three skips in a row: report `issue: none` and stop.

## 3. Write the issue

From `docs/internal/templates/refactor.md`, under delivery rule 12's
budgets, ending with `*Written by an agent.*`:

- **Why**: the measurement, as the command and the output line it printed.
- **Target shape**: the seams, read from the code with `rg -n`: what moves
  where, one bullet per new file or shared helper, as the ADR the target
  comes from shapes it (ADR 0063: a composition root over parts that own
  their state, the surface still `index.ts`).
- **Out of bounds**: the module's other files the target needs not touch,
  and every other module.
- **Done when**: the measurement passing, such as "`src/daemon/main.ts`
  has at most 1,400 lines" or "the clone group of `<file>:<lines>` is
  gone"; never a behaviour.

```bash
gh issue create --title "refactor(<module>): <the shape, in a few words>" --label refactor:new --body-file <scratch>/issue.md
node .agents/scripts/spec-lint.mjs <N>
```

Fix what the lint blocks, in the body, before the next step.

## 4. Ready it, or leave it for the maintainer

Set `refactor:ready` yourself only when all three of rule 18 hold:

1. the target came from step 1, and the issue quotes the command and line;
2. step 2 found nothing on its files;
3. the Target shape follows from an accepted ADR or from the measurement
   alone: no new seam a person would have to choose, no new module, no
   new name a user sees.

```bash
gh issue edit <N> --add-label refactor:ready --remove-label refactor:new
```

Otherwise leave it `refactor:new`, say which condition failed in one line,
report the issue and stop.

## 5. Deliver

Run the `deliver` procedure on `#<N>`, in this session. Once its draft PR
exists, label it:

```bash
gh pr edit <M> --add-label auto-refactor
```

(in a cloud session, `gh api -X POST repos/<owner>/<repo>/issues/<M>/labels -f 'labels[]=auto-refactor'`).
The gate (`merge-pr.sh`, which runs `refactor-check.mjs`) merges it or
parks it; either way report the issue, the PR and the gate's last line.
