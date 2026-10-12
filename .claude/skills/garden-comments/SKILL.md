---
name: garden-comments
description: Weekly routine — run the comment lint (architecture rule 17) over every comment in the code files main changed since the last run, prefix with `why:` the ones that say why and delete the rest, and land one comments-only PR through the reviews and the merge gate. Use when a Claude Code routine or the user says "garden comments".
model: sonnet
effort: low
---

# Garden comments

Rules: `docs/internal/agent-rules/architecture.md` rule 17, and
`delivery.md` rules 14 and 15. You are the author of this PR: there is no
issue and no implementer.

## 1. Workspace and list

```bash
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow
git fetch -q origin
dir=$(.agents/scripts/worktree.sh chore/garden-comments-$(date +%F)) && cd "$dir"
base=$(git log -1 --format=%H --grep='^chore(comments):' origin/main)
[ -n "$base" ] || base=$(git rev-list -1 --before='7 days ago' origin/main)
node .agents/scripts/comment-lint.mjs --all --base "$base" --head HEAD > <scratch>/comments.txt || true
```

Each line names a comment block in a file `main` changed since `<base>`
whose shape the rule does not allow. An empty list: report `PR: none` and
stop.

## 2. Judge and edit

Read each block. One that says why the code does something a reader would
not expect (an upstream bug, a platform quirk, an invariant the types
cannot express) keeps its text and gains `why:` as its first word. Every
other block is deleted whole: never reworded into a new comment, and no
code line changes. Then the lint prints nothing:

```bash
node .agents/scripts/comment-lint.mjs --all --base "$base" --head HEAD
```

## 3. Commit

```bash
pnpm test:changed
git add -A && git commit -m "chore(comments): delete comments that say what, not why, since <short base>"
git push -u origin HEAD
gh pr create --draft --title "chore(comments): delete comments that say what, not why, since <short base>" --body-file <scratch>/pr.md
```

The body: `<base>..<head>`, how many blocks the lint listed and how many
were deleted or prefixed, and `*Written by an agent.*`.

## 4. Review and merge

`reviewer` with the PR number, round 1: its kind must be `comments-only`.
Any other kind means a code line changed: undo it and push again. Fix each
Fix line yourself, comments only, then the check its Rerun names, as rule
14 says. `Rerun: none` with findings open: leave the PR in draft and report
them.

Add the `## Review` section exactly as the deliver skill's step 4 shapes it,
with `Spec review: skipped. Code review: skipped.`. Then `gh pr ready <M>`
and `.agents/scripts/merge-pr.sh <M>`. Anything but a merge: leave the PR
open and report.

## Report

```
Routine: garden-comments  Base: <short sha>  Listed: <n>  Deleted: <d>  Prefixed: <p>
PR: #M merged | #M open (<why>) | none
```
