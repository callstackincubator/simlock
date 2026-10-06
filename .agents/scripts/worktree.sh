#!/usr/bin/env sh
# Creates a git worktree and makes it buildable in seconds, with the pinned pnpm.
#
#   .agents/scripts/worktree.sh <name> [base]      base defaults to origin/main
#   .agents/scripts/worktree.sh --prepare <dir>    install into an existing worktree
#   echo '{"name":"<name>"}' | .agents/scripts/worktree.sh
#
# The stdin form is what Claude Code's WorktreeCreate hook uses (.claude/settings.json): the
# hook passes JSON on stdin and reads the last stdout line as the worktree path, so every other
# message goes to stderr. Worktrees live under <main checkout>/.claude/worktrees/, which is
# gitignored. A plain name gets branch worktree-<name>, as Claude Code's own default does. A
# name with a slash is a branch itself (task/118, bug/79): its directory is task-118, and an
# existing origin/<branch> is checked out instead of base, so delivery resumes where it stopped.
#
# node_modules of the main checkout is cloned with APFS clonefile(2): no data copied, blocks
# shared copy-on-write. pnpm then relinks offline, which takes about a second. Without
# clonefile (Linux) pnpm links from its store offline. If the store lacks a package the branch's
# lockfile needs, pnpm installs online once.
#
# pnpm is the version package.json pins under devEngines: ensure-pnpm.sh installs it into a
# cache when the one on PATH is missing or different, instead of failing later with a
# misleading error.
set -eu

main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")

check_pnpm() {
  bin=$("$(dirname "$0")/ensure-pnpm.sh")
  if [ -n "$bin" ]; then
    PATH="$bin:$PATH"
    export PATH
  fi
}

prepare() {
  dir=$1
  check_pnpm
  if [ "$(uname)" = Darwin ] && [ -d "$main_root/node_modules" ] && [ ! -e "$dir/node_modules" ]; then
    python3 - "$main_root/node_modules" "$dir/node_modules" <<'EOF' >&2
import ctypes, os, sys
src, dst = sys.argv[1], sys.argv[2]
libc = ctypes.CDLL("libSystem.dylib", use_errno=True)
if libc.clonefile(src.encode(), dst.encode(), 0) != 0:
    sys.exit(f"clonefile {src}: {os.strerror(ctypes.get_errno())}")
EOF
  fi
  (
    cd "$dir"
    pnpm install --frozen-lockfile --offline --ignore-scripts >/dev/null 2>&1 \
      || pnpm install --frozen-lockfile --ignore-scripts >&2
  )
}

if [ "${1:-}" = "--prepare" ]; then
  prepare "${2:?usage: worktree.sh --prepare <dir>}"
  exit 0
fi

if [ $# -eq 0 ]; then
  name=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).name))')
  base=origin/main
else
  name=$1
  base=${2:-origin/main}
fi

case $name in
  */*) branch=$name ;;
  *) branch="worktree-$name" ;;
esac
dir="$main_root/.claude/worktrees/$(echo "$name" | tr / -)"

# A rerun for the same branch gets the worktree it already has.
if [ -e "$dir" ]; then
  if [ "$(git -C "$dir" branch --show-current 2>/dev/null)" = "$branch" ]; then
    echo "$dir"
    exit 0
  fi
  echo "$dir already exists, on another branch" >&2
  exit 1
fi

check_pnpm
git -C "$main_root" fetch -q origin
if git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$main_root" worktree add -q "$dir" "$branch" >&2
elif git -C "$main_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$main_root" worktree add -q --track -b "$branch" "$dir" "origin/$branch" >&2
else
  git -C "$main_root" worktree add -q -b "$branch" "$dir" "$base" >&2
fi
prepare "$dir"

echo "$dir"
