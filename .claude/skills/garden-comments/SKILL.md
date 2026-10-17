---
name: garden-comments
description: Weekly routine — run the comment lint (architecture rule 17) over the comments in the code files main changed since the last run, up to 300 blocks a run, prefix with `why:` the ones that say why and delete the rest, and land one comments-only PR through the reviews and the merge gate. Use when a Claude Code routine or the user says "garden comments".
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
node .agents/scripts/comment-lint.mjs --all --limit 300 --base "$base" --head HEAD > <scratch>/comments.txt || true
```

Each line names a comment block in a file `main` changed since `<base>`
whose shape the rule does not allow; whole files, up to 300 blocks. Its
stderr says how many blocks it left for later runs. An empty list: report
`PR: none` and stop.

## 2. Judge and edit

Read each block. One that says why the code does something a reader would
not expect (an upstream bug, a platform quirk, an invariant the types
cannot express) keeps its text and gains `why:` as its first word. Every
other block is deleted whole: never reworded into a new comment, and no
code line changes. Then the lint prints nothing for the same files (no
`--head`: it reads the working tree, not the last commit):

```bash
node .agents/scripts/comment-lint.mjs --all --base "$base" $(cut -d: -f1 <scratch>/comments.txt | sort -u)
```

## 3. Commit

```bash
pnpm test:changed
git add -A && git commit -m "chore(comments): delete comments that say what, not why, since <short base>"
git push -u origin HEAD
gh api -X POST repos/<owner>/<repo>/pulls -f title="chore(comments): delete comments that say what, not why, since <short base>" \
  -f head="$(git branch --show-current)" -f base=main -F draft=true -F body=@<scratch>/pr.md -q .number
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
with `Spec review: skipped. Code review: skipped.` (edit the body with
`gh api -X PATCH repos/<owner>/<repo>/pulls/<M> -F body=@<file>`; `gh pr edit`
is GraphQL, which a cloud session refuses). Then `gh pr ready <M>`
(in a cloud session it fails with a 403 naming the proxy's ready-for-review
route: call that route) and `.agents/scripts/merge-pr.sh <M>`. Anything but a merge: leave the PR
open and report.

## Report

```
Routine: garden-comments  Base: <short sha>  Listed: <n>  Deleted: <d>  Prefixed: <p>  Left: <l>
PR: #M merged | #M open (<why>) | none
```

Review follow-up uses `docs/internal/REVIEW.md`: pass the previous SHA and
resolution ledger, classify actual impacts and recheck changed assertions
with code/tests and changed claims with claims. Record all invocations and
Assessment. The round cap parks unresolved blocking or incomplete work;
tests/comments are not blanket exemptions from recheck.
