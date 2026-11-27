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
#   scripts/slow-e2e.sh check     the checks a run starts with: clean and the worker lock (neither
#                                 while a run holds the lane lock), then free disk and the lane's
#                                 agent-device
#   scripts/slow-e2e.sh check --fix            the same, and installs the agent-device the
#                                 checkout pins when the lane has none (not while a run holds
#                                 the lock); a run starts with it
#   scripts/slow-e2e.sh check --fix --dry-run  lists what --fix would stop, remove and install,
#                                 and changes nothing
#
# Vitest arguments pass through: `-t <title>` runs one test, `--bail=1` stops at the first
# failure. A run prints its log path and exits at once; it writes its exit code to <log>.exit
# when it ends. Exits 75 without starting when another worktree's run holds the lock: real
# simulators and emulators share one machine, and two lanes at once make timeouts that look
# like bugs. Exits 69 without starting when the machine is not fit to run it: too little free
# disk, a Simlock worker outside the lane holding the machine's worker lock, or no install of
# the agent-device version package.json pins for @agent-device/proxy. The lock is a directory
# holding the pid of the run's shell while it checks and installs, then the runner's; a lock
# whose pid is gone is stale and is taken over.
#
# The lane keeps its own agent-device, one npm install per pinned version, under
# ~/.cache/simlock-slow-lane, and a run gets its path as SIMLOCK_E2E_AGENT_DEVICE, whatever the
# caller's environment says.
#
# Before a run it sources `.slow-lane.env` from the main checkout's root, if there is one: this
# machine's settings, such as SIMLOCK_PHYSICAL_ANDROID. A run's temporary homes live under
# /tmp/simlock-slow, so `clean` and `stop` find a run's daemons, emulators and simulators by
# that path and touch nothing else, except the simulators in Xcode's own device set whose durable
# mark names the instance of a home under that path (a daemon run with drivers.ios.deviceSet
# "default" keeps them there): `clean` and `stop` delete those too. A run starts by cleaning up
# after earlier ones.
#
# The run is detached from the calling shell, so no tool time limit kills it halfway and
# leaves booted devices behind. Its own harness tears down the devices it created.
set -eu

# why: the overrides let the script's own tests use a scratch lock, home and tools directory.
lock=${SIMLOCK_SLOW_LOCK:-/tmp/simlock-slow-e2e.lock}
lane_tmp=${SIMLOCK_SLOW_TMP:-/tmp/simlock-slow}
# why: outside lane_tmp, which every run empties, so one install serves every run of its version.
tools=${SIMLOCK_SLOW_TOOLS:-$HOME/.cache/simlock-slow-lane}
min_free=${SIMLOCK_SLOW_MIN_FREE_GIB:-15}
# why: the worker lock the daemon takes (ADR 0059); src/slow-e2e.test.ts keeps this default equal to defaultWorkerLockPath.
worker_lock=${SIMLOCK_SLOW_WORKER_LOCK:-/tmp/simlock-$(id -u)/worker.lock}
root=$(git rev-parse --show-toplevel)

# why: on Windows 11 `python3` is by default the Microsoft Store alias, which prints "Python was
# not found" instead of a version; the first of the two that says "Python 3" is the interpreter.
py=python3
case $(python3 --version 2>&1) in "Python 3"*) ;; *) py=python ;; esac

helper() {
  $py - "$lock" "$lane_tmp" "$root" "$min_free" "$worker_lock" "$tools" "${starter:-}" "$@" <<'EOF'
import json, os, re, shutil, signal, subprocess, sys, tempfile, time
lock, lane_tmp, root, min_free, worker_lock, tools, starter, command = sys.argv[1:9]
flags = sys.argv[9:]

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
    # why: a run holds the lock under its own shell's pid while it starts; to the check that run makes, that is no other lane.
    pid = read(os.path.join(lock, "pid"))
    return pid if pid and pid != starter and alive(pid) else None

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

def clean(dry=False):
    procs = leftovers()
    if dry:
        for pid, name in procs:
            print(f"would stop {pid} {name}")
        delete_marked_simulators(dry)
        if os.path.isdir(lane_tmp):
            print(f"would remove {lane_tmp} ({mib(lane_tmp)} MiB)")
        return procs
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
    return []

def mib(folder):
    total = 0
    for base, _, files in os.walk(folder):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total // 2**20

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

def delete_marked_simulators(dry=False):
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
            if dry:
                print(f"would delete simulator {udid}")
                continue
            subprocess.run(["xcrun", "simctl", "shutdown", udid], capture_output=True)
            subprocess.run(["xcrun", "simctl", "delete", udid], capture_output=True)
            print(f"deleted simulator {udid}")

def free_gib(path):
    # why: os.statvfs does not exist on Windows; disk_usage reports the same free bytes.
    return shutil.disk_usage(path).free / 2**30

def pinned_agent_device():
    # why: the lane runs the agent-device release whose proxy simlock bundles; a pin that is not one exact version names no release to install.
    pinned = json.loads(read(os.path.join(root, "package.json"), "{}")).get("dependencies", {}).get("@agent-device/proxy")
    return pinned if isinstance(pinned, str) and re.fullmatch(r"\d+\.\d+\.\d+", pinned) else None

def agent_device_folder(version):
    return os.path.join(tools, f"agent-device-{version}")

def agent_device_entry(version):
    package = os.path.join(agent_device_folder(version), "node_modules", "agent-device")
    entry = os.path.join(package, "bin", "agent-device.mjs")
    try:
        found = json.loads(read(os.path.join(package, "package.json"), "{}")).get("version")
    except ValueError:
        found = None
    return entry if found == version and os.path.isfile(entry) else None

def install_agent_device(version):
    npm = shutil.which("npm")
    if npm is None:
        return "npm is not on PATH; install it"
    folder = agent_device_folder(version)
    # why: npm writes into a folder of this call's own, renamed in when whole, so a killed install never passes for one. Nothing under the final name is ever removed: a run may be using it, and a call that finishes second keeps the first one's install.
    staging = f"{folder}.installing-{os.getpid()}"
    try:
        os.makedirs(staging)
        done = subprocess.run(
            [npm, "install", "--prefix", staging, "--no-audit", "--no-fund", "--no-save", f"agent-device@{version}"],
            cwd=staging, capture_output=True, text=True, timeout=600,
        )
        if done.returncode != 0:
            return ("; ".join([l.strip() for l in done.stderr.splitlines() if l.strip()][:2]) or f"npm install exited {done.returncode}") + "; fix npm or the network"
        if not agent_device_entry(version):
            os.rename(staging, folder)
    except subprocess.TimeoutExpired:
        return "npm install ran over 600 s; fix npm or the network"
    except OSError as error:
        if not agent_device_entry(version):
            return f"{folder} holds something else; remove it" if os.path.exists(folder) else f"{error}; fix it"
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return None

if command == "clean":
    if holder():
        print(f"busy: a slow-lane run holds the lock (pid {holder()}); stop it first", file=sys.stderr)
        sys.exit(75)
    clean()

elif command == "agent-device":
    print(agent_device_entry(pinned_agent_device() or "") or "")

elif command == "check":
    fix, dry = "--fix" in flags, "--dry-run" in flags
    if (dry and not fix) or any(flag not in ("--fix", "--dry-run") for flag in flags):
        print("usage: scripts/slow-e2e.sh check [--fix [--dry-run]]", file=sys.stderr)
        sys.exit(64)
    # why: a running lane's processes, home, worker and agent-device are its own, not leftovers; cleaning or installing under it fails its tests.
    running = holder()
    would_stop = [] if running else [pid for pid, _ in clean(dry)]
    problems = []
    version = pinned_agent_device()
    if version and not agent_device_entry(version):
        folder = agent_device_folder(version)
        if running or not fix:
            problems.append(f"agent-device {version} is not installed in {folder}; run scripts/slow-e2e.sh check --fix{' once the running lane ends' if running else ''}")
        elif dry:
            print(f"would install agent-device {version} into {folder}")
        else:
            failed = install_agent_device(version)
            if failed:
                problems.append(f"agent-device {version} did not install into {folder}: {failed}, then run scripts/slow-e2e.sh check --fix")
            else:
                print(f"installed agent-device {version} into {folder}")
    # why: with no lane running, a lane worker an aborted run left is already killed by clean(), so a live holder is a worker outside the lane (ADR 0059 §4).
    try:
        owner = json.loads(read(os.path.join(worker_lock, "owner.json"), "{}"))
        if not running and alive(owner["pid"]) and owner["pid"] not in would_stop:
            print(f"not fit: a Simlock worker holds this machine (pid {owner['pid']}, folder {owner['folder']}); stop it first: SIMLOCK_HOME={owner['folder']} simlock daemon stop", file=sys.stderr)
            sys.exit(69)
    except (ValueError, KeyError, TypeError):
        pass
    # why: /tmp is not a folder for a Windows Python, which uses its own temp folder.
    for path in ("/tmp" if os.path.isdir("/tmp") else tempfile.gettempdir(), os.path.expanduser("~")):
        if free_gib(path) < float(min_free):
            problems.append(f"{free_gib(path):.1f} GiB free on the volume of {path}; the lane needs {min_free}")
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
  status | stop | clean | check) helper "$@"; exit $? ;;
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
# why: the check below may install for minutes; this shell's pid makes the lock a held one for all of it, until the runner's pid replaces it.
starter=$$
echo "$starter" > "$lock/pid"
echo "$root" > "$lock/root"
echo "$log" > "$lock/log"
# why: a caller reads this script's output as the log path, so what the check stops and installs goes to stderr.
if ! helper check --fix >&2; then
  rm -rf "$lock"
  exit 69
fi
# why: `stop` during the check removes the lock; a run it stopped must not start.
if [ "$(cat "$lock/pid" 2>/dev/null)" != "$starter" ]; then
  echo "stopped: the lane lock was removed while this run was starting" >&2
  exit 75
fi
# why: the lane's own install, not a path set by hand, so the version is always the one this checkout pins.
agent_device=$(helper agent-device)
if [ -n "$agent_device" ]; then
  export SIMLOCK_E2E_AGENT_DEVICE="$agent_device"
fi
echo "$log" > "$lock.last"
mkdir -p "$lane_tmp"

SIMLOCK_E2E_LOG_DIR="${log%.log}-daemons" TMPDIR="$lane_tmp/" $py - "$lock" "$log" "$root" "$script" "$@" <<'EOF'
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
