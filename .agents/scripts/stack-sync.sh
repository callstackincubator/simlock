#!/usr/bin/env sh
# Brings a feature's PR stack up to date by merging forward, bottom to top, never by rebasing:
#
#   .agents/scripts/stack-sync.sh <top pr> [--dry-run]
#
# The chain is read from GitHub: the top PR's base is the PR below, down to main. For each branch
# in that order, in a temporary detached worktree (never a task's worktree, never local main),
# origin/<parent> is merged into origin/<branch> and the result pushed as a fast-forward of the
# branch. A merge commit needs no force push, so no human has to push, and `settings.json` keeps
# denying `git push --force`. The first conflict stops the sync: it prints `conflict <branch>
# <parent>` and the files, removes the worktree, and exits 3; the orchestrator sends that branch
# a fix run whose `stack:` line names the parent to merge, then runs this script again. Prints
# `synced <branch> <sha>` or `current <branch>` per branch. --dry-run prints the chain and exits.
# The repo is GH_REPO, else the origin remote's owner/name.
set -eu
top=${1:-}
dry=${2:-}
case $top in '' | *[!0-9]*) echo "usage: stack-sync.sh <top pr> [--dry-run]" >&2; exit 64 ;; esac
here=$(cd "$(dirname "$0")" && pwd)
root=$(git rev-parse --show-toplevel)
nwo=${GH_REPO:-$(git remote get-url origin | sed -E 's#\.git$##; s#.*[/:]([^/:]+/[^/]+)$#\1#')}
say() { echo "stack-sync: $*" >&2; }

# why: a cloud session's GitHub proxy refuses GraphQL, so the chain comes from REST, one PR at a time.
chain=
pr=$top
trunk=
while :; do
  info=$(gh api -X GET "repos/$nwo/pulls/$pr" -q '"\(.head.ref) \(.base.ref) \(.state) \(.number)"')
  set -- $info
  [ "$3" = open ] || { say "PR #$4 is $3, not open"; exit 65; }
  chain="$1 $chain"
  case $2 in
    main | master) trunk=$2; break ;;
  esac
  pr=$(gh api -X GET "repos/$nwo/pulls?head=${nwo%%/*}:$2&state=open" -q '.[0].number // empty')
  [ -n "$pr" ] || { say "no open PR for branch $2 (the base of #$4); link the stack first"; exit 65; }
done
say "chain, bottom to top: $trunk -> $(echo "$chain" | sed 's/ $//; s/ / -> /g')"
[ "$dry" != --dry-run ] || exit 0

git fetch -q origin
parent=$trunk
for branch in $chain; do
  if git merge-base --is-ancestor "origin/$parent" "origin/$branch"; then
    echo "current $branch"
    parent=$branch
    continue
  fi
  wt=$(mktemp -d "${TMPDIR:-/tmp}/stack-sync.XXXXXX")
  rmdir "$wt"
  git worktree add -q --detach "$wt" "origin/$branch"
  "$here/worktree.sh" --prepare "$wt" >/dev/null 2>&1 || true
  if ! git -C "$wt" merge -q --no-edit "origin/$parent" >/dev/null 2>&1; then
    files=$(git -C "$wt" diff --name-only --diff-filter=U | tr '\n' ' ')
    git -C "$wt" merge --abort || true
    git worktree remove --force "$wt"
    echo "conflict $branch $parent $files"
    exit 3
  fi
  git -C "$wt" push -q origin "HEAD:refs/heads/$branch"
  sha=$(git -C "$wt" rev-parse --short HEAD)
  git worktree remove --force "$wt"
  git fetch -q origin "$branch"
  echo "synced $branch $sha"
  parent=$branch
done
