#!/usr/bin/env sh
# Runs the slow e2e lane (real simctl and Android SDK) detached, one run per machine.
#
#   scripts/slow-e2e.sh [vitest args...]    e.g. scripts/slow-e2e.sh e2e/slow-ios-slim.test.ts
#
# Prints the log path and exits at once. The run writes its exit code to <log>.exit when it
# ends. Exits 75 without starting when another worktree's slow run holds the lock: real
# simulators and emulators share one machine, and two lanes at once make timeouts that look
# like bugs. The lock is a directory holding the runner's pid; a lock whose pid is gone is
# stale and is taken over.
#
# The run is detached from the calling shell, so no tool time limit kills it halfway and
# leaves booted devices behind. Its own harness tears down the devices it created.
set -eu

root=$(git rev-parse --show-toplevel)
lock=/tmp/simlock-slow-e2e.lock
log="${TMPDIR:-/tmp}/simlock-slow-e2e-$(date +%Y%m%d-%H%M%S).log"

if ! mkdir "$lock" 2>/dev/null; then
  holder=$(cat "$lock/pid" 2>/dev/null || echo "")
  # No pid yet means another caller is still starting its runner, unless that was long ago.
  if { [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; } \
    || { [ -z "$holder" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin -1)" ]; }; then
    echo "busy: slow lane running as pid $holder from $(cat "$lock/root" 2>/dev/null), log $(cat "$lock/log" 2>/dev/null)" >&2
    exit 75
  fi
  rm -rf "$lock"
  mkdir "$lock"
fi
echo "$root" > "$lock/root"
echo "$log" > "$lock/log"

# The runner owns the lock from here: it records its pid, runs the lane, writes the exit code,
# and removes the lock however the lane ends.
python3 - "$lock" "$log" "$root" "$@" <<'EOF'
import os, subprocess, sys
lock, log, root, args = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
child = os.fork()
if child != 0:
    # Written before this returns, so a second caller never sees a lock without a live pid.
    with open(os.path.join(lock, "pid"), "w") as f:
        f.write(str(child))
    sys.exit(0)
os.setsid()
# Let go of the caller's stdout and stderr, or `$(scripts/slow-e2e.sh)` waits for the whole run.
null = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(null, fd)
with open(log, "w") as out:
    code = subprocess.call(
        ["pnpm", "run", "test:e2e:slow", *args],
        cwd=root, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    )
with open(log + ".exit", "w") as f:
    f.write(f"{code}\n")
subprocess.call(["rm", "-rf", lock])
EOF

echo "$log"
