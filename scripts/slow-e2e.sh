#!/usr/bin/env sh
# Runs the slow e2e lane (real simctl and Android SDK) detached, one run per machine.
#
#   scripts/slow-e2e.sh [vitest args...]    e.g. scripts/slow-e2e.sh e2e/slow-ios-slim.test.ts
#   scripts/slow-e2e.sh --physical <files>          the phone lane (tag `physical`, no person)
#   scripts/slow-e2e.sh --physical-manual <files>   the phone lane with a person (tag `physical-manual`)
#   scripts/slow-e2e.sh status    the running lane: its tests so far, the one running, how long
#                                 the log has been quiet; or the last run's log and exit code
#   scripts/slow-e2e.sh stop      stops the running lane and what it started, and frees the lock
#   scripts/slow-e2e.sh clean     stops what earlier runs left behind (refused while a lane runs)
#   scripts/slow-e2e.sh check     the checks a run starts with: clean, then free disk and builds
#
# Vitest arguments pass through: `-t <title>` runs one test, `--bail=1` stops at the first
# failure. A run prints its log path and exits at once; it writes its exit code to <log>.exit
# when it ends. Exits 75 without starting when another worktree's run holds the lock: real
# simulators and emulators share one machine, and two lanes at once make timeouts that look
# like bugs. Exits 69 without starting when the machine is not fit to run it: too little free
# disk, or SIMLOCK_E2E_AGENT_DEVICE naming an agent-device of another version than package.json
# pins for @agent-device/proxy, or a checkout never built. The lock is a directory holding the runner's pid; a lock whose pid is
# gone is stale and is taken over.
#
# Before a run it sources `.slow-lane.env` from the main checkout's root, if there is one: this
# machine's settings, such as SIMLOCK_E2E_AGENT_DEVICE. A run's temporary homes live under
# /tmp/simlock-slow, so `clean` and `stop` find a run's daemons, emulators and simulators by
# that path and touch nothing else, except the simulators in Xcode's own device set whose durable
# mark names the instance of a home under that path (a daemon run with drivers.ios.deviceSet
# "default" keeps them there): `clean` and `stop` delete those too. A run starts by cleaning up
# after earlier ones.
#
# The run is detached from the calling shell, so no tool time limit kills it halfway and
# leaves booted devices behind. Its own harness tears down the devices it created.
set -eu

# why: the three overrides let the script's own tests use a scratch lock and home directory.
lock=${SIMLOCK_SLOW_LOCK:-/tmp/simlock-slow-e2e.lock}
lane_tmp=${SIMLOCK_SLOW_TMP:-/tmp/simlock-slow}
min_free=${SIMLOCK_SLOW_MIN_FREE_GIB:-15}
root=$(git rev-parse --show-toplevel)

helper() {
  python3 - "$lock" "$lane_tmp" "$root" "$min_free" "$@" <<'EOF'
import json, os, re, shutil, signal, subprocess, sys, time
lock, lane_tmp, root, min_free, command = sys.argv[1:6]

def read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default

def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False

def holder():
    pid = read(os.path.join(lock, "pid"))
    return pid if pid and alive(pid) else None

def leftovers():
    # why: a run's processes name its homes in their command line (simulators) or environment
    # (daemons and emulators); /tmp is /private/tmp on macOS, so either spelling matches.
    needle = re.compile(r"(?:/private)?" + re.escape(lane_tmp) + r"/")
    found = []
    flag = ["-E"] if sys.platform == "darwin" else []
    out = subprocess.run(["ps", "-ax", "-ww", *flag, "-o", "pid=,command="], capture_output=True, text=True).stdout
    for row in out.splitlines():
        pid, _, text = row.strip().partition(" ")
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        if sys.platform != "darwin":
            text += " " + read(f"/proc/{pid}/environ").replace("\0", " ")
        if needle.search(text):
            found.append((int(pid), text.split(" ")[0]))
    return found

def clean():
    procs = leftovers()
    for pid, _ in procs:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.time() + 20
    while time.time() < deadline and any(alive(pid) for pid, _ in procs):
        time.sleep(1)
    for pid, _ in procs:
        if alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    delete_marked_simulators()
    shutil.rmtree(lane_tmp, ignore_errors=True)
    for pid, name in procs:
        print(f"stopped {pid} {name}")

def lane_instance_ids():
    # why: each lane home holds its instance id in instance.json (a gateway's under gateway/); the homes sit one or two levels below lane_tmp.
    ids = set()
    for base, dirs, files in os.walk(lane_tmp):
        if base[len(lane_tmp):].count(os.sep) >= 3:
            dirs[:] = []
        if "instance.json" in files:
            try:
                ids.add(json.loads(read(os.path.join(base, "instance.json")))["instanceId"])
            except (ValueError, KeyError, TypeError):
                pass
    return ids

def delete_marked_simulators():
    # why: with drivers.ios.deviceSet "default" the lane's simulators live in the maintainer's Xcode set, which removing the lane folder does not clean; only a durable mark naming a lane instance proves a simulator is the lane's.
    ids = lane_instance_ids()
    devices = os.environ.get("SIMLOCK_SLOW_DEVICES") or os.path.expanduser("~/Library/Developer/CoreSimulator/Devices")
    if not ids or not os.path.isdir(devices):
        return
    for udid in sorted(os.listdir(devices)):
        try:
            mark = json.loads(read(os.path.join(devices, udid, "simlock-mark.json")))
        except ValueError:
            continue
        if isinstance(mark, dict) and mark.get("instanceId") in ids:
            subprocess.run(["xcrun", "simctl", "shutdown", udid], capture_output=True)
            subprocess.run(["xcrun", "simctl", "delete", udid], capture_output=True)
            print(f"deleted simulator {udid}")

def free_gib(path):
    stats = os.statvfs(path)
    return stats.f_bavail * stats.f_frsize / 2**30

if command == "clean":
    if holder():
        print(f"busy: a slow-lane run holds the lock (pid {holder()}); stop it first", file=sys.stderr)
        sys.exit(75)
    clean()

elif command == "check":
    clean()
    problems = []
    for path in ("/tmp", os.path.expanduser("~")):
        if free_gib(path) < float(min_free):
            problems.append(f"{free_gib(path):.1f} GiB free on the volume of {path}; the lane needs {min_free}")
    agent_device = os.environ.get("SIMLOCK_E2E_AGENT_DEVICE")
    if agent_device:
        install = os.path.dirname(os.path.dirname(agent_device))
        pinned = json.loads(read(os.path.join(root, "package.json"), "{}")).get("dependencies", {}).get("@agent-device/proxy")
        found = json.loads(read(os.path.join(install, "package.json"), "{}")).get("version")
        if pinned and found != pinned:
            problems.append(f"SIMLOCK_E2E_AGENT_DEVICE is agent-device {found or 'of no version'}; package.json pins {pinned}")
        if not os.path.isdir(os.path.join(install, "dist")):
            problems.append(f"SIMLOCK_E2E_AGENT_DEVICE's install {install} has no dist/: build it first")
    for problem in problems:
        print(f"unfit: {problem}", file=sys.stderr)
    sys.exit(69 if problems else 0)

elif command == "stop":
    pid = holder()
    if pid is None:
        print("idle: no slow-lane run holds the lock")
    else:
        log = read(os.path.join(lock, "log"))
        for sig, wait in ((signal.SIGTERM, 30), (signal.SIGKILL, 5)):
            try:
                os.killpg(int(pid), sig)
            except OSError:
                break
            deadline = time.time() + wait
            while time.time() < deadline and alive(pid):
                time.sleep(1)
        if log and not os.path.exists(log + ".exit"):
            with open(log + ".exit", "w") as f:
                f.write("143\n")
        shutil.rmtree(lock, ignore_errors=True)
        print(f"stopped run {pid}, log {log}")
    clean()

elif command == "status":
    pid = holder()
    log = read(os.path.join(lock, "log")) if pid else read(lock + ".last")
    if not log or not os.path.exists(log):
        print("idle: no slow-lane run yet")
        sys.exit(0)
    lines = read(log).splitlines()
    ends = [l for l in lines if " SLOW END " in l]
    count = {state: sum(f" SLOW END {state} " in l for l in ends) for state in ("passed", "failed", "skipped")}
    quiet = (time.time() - os.path.getmtime(log)) / 60
    print(f"{'running: pid ' + pid if pid else 'ended: exit ' + read(log + '.exit', '?')}, log {log}")
    print(f"tests: {count['passed']} passed, {count['failed']} failed, {count['skipped']} skipped")
    starts = [l for l in lines if " SLOW START " in l]
    if pid and len(starts) > len(ends):
        print(f"now: {starts[-1].split(' SLOW START ', 1)[1]}")
    if pid:
        print(f"log quiet for {quiet:.0f} min")
    for l in lines:
        if " SLOW ERROR " in l or " SLOW END failed " in l:
            print(l.split(" SLOW ", 1)[1])
EOF
}

case "${1:-}" in
  status | stop | clean | check) helper "$1"; exit $? ;;
esac

script=test:e2e:slow
case "${1:-}" in
  --physical) script=test:e2e:physical; shift ;;
  --physical-manual) script=test:e2e:physical-manual; shift ;;
esac

machine_env="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.slow-lane.env"
if [ -f "$machine_env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$machine_env"
  set +a
fi

log="${TMPDIR:-/tmp}/simlock-slow-e2e-$(date +%Y%m%d-%H%M%S).log"

if ! mkdir "$lock" 2>/dev/null; then
  holder=$(cat "$lock/pid" 2>/dev/null || echo "")
  # why: No pid yet means another caller is still starting its runner, unless that was long ago.
  if { [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; } \
    || { [ -z "$holder" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin -1)" ]; }; then
    echo "busy: slow lane running as pid $holder from $(cat "$lock/root" 2>/dev/null), log $(cat "$lock/log" 2>/dev/null)" >&2
    exit 75
  fi
  rm -rf "$lock"
  mkdir "$lock"
fi
if ! helper check; then
  rm -rf "$lock"
  exit 69
fi
echo "$root" > "$lock/root"
echo "$log" > "$lock/log"
echo "$log" > "$lock.last"
mkdir -p "$lane_tmp"

TMPDIR="$lane_tmp/" python3 - "$lock" "$log" "$root" "$script" "$@" <<'EOF'
import os, subprocess, sys
lock, log, root, script, args = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
child = os.fork()
if child != 0:
    # why: Written before this returns, so a second caller never sees a lock without a live pid.
    with open(os.path.join(lock, "pid"), "w") as f:
        f.write(str(child))
    sys.exit(0)
os.setsid()
# why: Let go of the caller's stdout and stderr, or `$(scripts/slow-e2e.sh)` waits for the whole run.
null = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(null, fd)
with open(log, "w") as out:
    code = subprocess.call(
        ["pnpm", "run", script, *args],
        cwd=root, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    )
with open(log + ".exit", "w") as f:
    f.write(f"{code}\n")
subprocess.call(["rm", "-rf", lock])
EOF

echo "$log"
