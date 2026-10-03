#!/usr/bin/env sh
# Makes sure the pnpm version package.json pins (devEngines) is the one on PATH.
#
#   .agents/scripts/ensure-pnpm.sh          print the bin directory to put first on PATH
#   .agents/scripts/ensure-pnpm.sh --hook   Claude Code SessionStart: export it via $CLAUDE_ENV_FILE
#
# The pnpm on PATH is used when it is the pinned version. Otherwise, missing or wrong, the
# pinned version is installed once into ~/.cache/simlock/pnpm-<version> with npm and used from
# there; the global pnpm and node are never touched. Installing runs npm outside the repo,
# because npm refuses to run inside it (devEngines names pnpm, not npm).
#
# Prints nothing and changes nothing when the right pnpm is already on PATH. Messages go to
# stderr, so a hook's stdout stays empty.
set -eu

root=$(git rev-parse --show-toplevel)
want=$(node -p 'require(process.argv[1]).devEngines.packageManager.version' "$root/package.json")

if [ "$(pnpm --version 2>/dev/null || true)" = "$want" ]; then
  exit 0
fi

dir="${XDG_CACHE_HOME:-$HOME/.cache}/simlock/pnpm-$want"
bin="$dir/node_modules/.bin"
if [ "$("$bin/pnpm" --version 2>/dev/null || true)" != "$want" ]; then
  echo "pnpm $want not on PATH; installing it into $dir" >&2
  mkdir -p "$dir"
  (cd "$dir" && npm install --prefix "$dir" --no-save --no-audit --no-fund --loglevel=error "pnpm@$want" >&2)
fi

if [ "${1:-}" = "--hook" ]; then
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
else
  echo "$bin"
fi
