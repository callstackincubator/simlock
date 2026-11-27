import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { defaultWorkerLockPath } from "./ports/index.js";
import { fakeCommandEnv, scriptCommand, writeFakeCommand } from "./test-support/fake-command.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "slow-e2e.sh");
const PINNED = "0.21.28";

// why: idleNode makes its process with os.fork(), which Windows does not have.
const forks = it.skipIf(process.platform === "win32");

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // why: most are already stopped by the script under test.
    }
  }
});

// why: the script's Python prints "\r\n" line ends on Windows.
function lf<T extends { stdout: string; stderr: string }>(result: T): T {
  return {
    ...result,
    stdout: result.stdout.replaceAll("\r\n", "\n"),
    stderr: result.stderr.replaceAll("\r\n", "\n"),
  };
}

// why: what `npm install --prefix <folder> agent-device@<version>` leaves in the lane's tools folder.
function agentDeviceInstall(tools: string, version: string, folder = version): string {
  const install = join(tools, `agent-device-${folder}`, "node_modules", "agent-device");
  mkdirSync(join(install, "bin"), { recursive: true });
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "agent-device", version }));
  writeFileSync(join(install, "bin", "agent-device.mjs"), "");
  return join(install, "bin", "agent-device.mjs");
}

// why: a stand-in for npm that records its arguments and, like the real one run in the staging
// folder, leaves the package under node_modules there.
function fakeNpm(bin: string, calls: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(calls, "");
  writeFakeCommand(
    bin,
    "npm",
    [
      "#!/bin/sh",
      `echo "$@" >> "${calls}"`,
      'for spec in "$@"; do :; done',
      "mkdir -p node_modules/agent-device/bin",
      `printf '{"name":"agent-device","version":"%s"}' "\${spec#agent-device@}" > node_modules/agent-device/package.json`,
      ": > node_modules/agent-device/bin/agent-device.mjs",
      "",
    ].join("\n"),
  );
}

function machine({ installed = true }: { installed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "slow-e2e-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ dependencies: { "@agent-device/proxy": PINNED } }),
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = {
    ...process.env,
    SIMLOCK_SLOW_LOCK: join(dir, "lane.lock"),
    SIMLOCK_SLOW_TMP: join(dir, "lane"),
    SIMLOCK_SLOW_MIN_FREE_GIB: "0",
    SIMLOCK_SLOW_WORKER_LOCK: join(dir, "worker.lock"),
    SIMLOCK_SLOW_TOOLS: join(dir, "tools"),
  };
  if (installed) agentDeviceInstall(env.SIMLOCK_SLOW_TOOLS, PINNED);
  const run = (...args: string[]) =>
    lf(
      spawnSync(...scriptCommand(SCRIPT, args), {
        cwd: repo,
        env,
        encoding: "utf8",
        timeout: 60_000,
      }),
    );
  const runWith = (extra: NodeJS.ProcessEnv, ...args: string[]) =>
    lf(
      spawnSync(...scriptCommand(SCRIPT, args), {
        cwd: repo,
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 60_000,
      }),
    );
  return {
    dir,
    repo,
    env,
    run,
    runWith,
    lock: env.SIMLOCK_SLOW_LOCK,
    lane: env.SIMLOCK_SLOW_TMP,
    tools: env.SIMLOCK_SLOW_TOOLS,
  };
}

// why: a process that is not this test's child, as a lane's are not the script's, so it is
// reaped as soon as it stops instead of staying a zombie while spawnSync blocks; `group` makes
// it lead its own process group, as the lane's runner does.
function idleNode(env: NodeJS.ProcessEnv, group = false): number {
  const pid = Number(
    execFileSync(
      "python3",
      [
        "-c",
        [
          "import os, sys",
          "pid = os.fork()",
          "if pid: print(pid); sys.exit(0)",
          `if ${group ? "True" : "False"}: os.setsid()`,
          "fd = os.open(os.devnull, os.O_RDWR)",
          "[os.dup2(fd, n) for n in (0, 1, 2)]",
          `os.execvp("node", ["node", "-e", "setTimeout(() => {}, 60000)"])`,
        ].join("\n"),
      ],
      { env, encoding: "utf8" },
    ),
  );
  started.push(pid);
  return pid;
}

const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

describe("scripts/slow-e2e.sh", () => {
  it("status says idle before any run", () => {
    const { run } = machine();

    expect(run("status").stdout).toBe("idle: no slow-lane run yet\n");
  });

  it("status of an ended run counts its tests from the progress lines and prints each failure", () => {
    const { dir, lock, run } = machine();
    const log = join(dir, "run.log");
    writeFileSync(
      log,
      [
        "2026-10-14T09:00:00.000Z SLOW START e2e/a.test.ts > one",
        "2026-10-14T09:01:00.000Z SLOW END passed 60s e2e/a.test.ts > one",
        "2026-10-14T09:01:00.000Z SLOW START e2e/a.test.ts > two",
        "2026-10-14T09:05:00.000Z SLOW END failed 240s e2e/a.test.ts > two",
        "2026-10-14T09:05:00.000Z SLOW ERROR waitFor timed out after 240000ms",
        "",
      ].join("\n"),
    );
    writeFileSync(`${log}.exit`, "1\n");
    writeFileSync(`${lock}.last`, `${log}\n`);

    expect(run("status").stdout).toBe(
      [
        `ended: exit 1, log ${log}`,
        "tests: 1 passed, 1 failed, 0 skipped",
        "END failed 240s e2e/a.test.ts > two",
        "ERROR waitFor timed out after 240000ms",
        "",
      ].join("\n"),
    );
  });

  forks(
    "clean stops a process whose environment names the lane's home, removes the home, and leaves other processes alone",
    async () => {
      const { lane, run } = machine();
      mkdirSync(lane, { recursive: true });
      const leftover = idleNode({ ...process.env, SIMLOCK_HOME: join(lane, "simlock-e2e-abc") });
      const other = idleNode({ ...process.env, SIMLOCK_HOME: join(tmpdir(), "simlock-e2e-other") });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = run("clean");

      expect(result.stdout).toMatch(new RegExp(`^stopped ${leftover} \\S*node$`, "m"));
      expect(alive(leftover)).toBe(false);
      expect(alive(other)).toBe(true);
      expect(existsSync(lane)).toBe(false);
    },
  );

  it("clean and stop delete, before removing the lane, the simulators whose durable mark names a lane instance, and no other", () => {
    const { dir, env, lane } = machine();
    const devices = join(dir, "Devices");
    const bin = join(dir, "bin");
    const calls = join(dir, "xcrun-calls.txt");
    mkdirSync(bin);
    writeFakeCommand(bin, "xcrun", `#!/bin/sh\necho "$@" >> "${calls}"\n`);
    const mark = (udid: string, body: string | undefined) => {
      mkdirSync(join(devices, udid), { recursive: true });
      if (body !== undefined) writeFileSync(join(devices, udid, "simlock-mark.json"), body);
    };
    mark("MINE-1", JSON.stringify({ instanceId: "lane-one", token: "t", udid: "MINE-1" }));
    mark("MINE-2", JSON.stringify({ instanceId: "lane-two", token: "t", udid: "MINE-2" }));
    mark("OTHER", JSON.stringify({ instanceId: "somebody-else", token: "t", udid: "OTHER" }));
    mark("NO-INSTANCE", JSON.stringify({ token: "t", udid: "NO-INSTANCE" }));
    mark("UNMARKED", undefined);
    mark("CORRUPT", "{not json");
    const seedLane = () => {
      mkdirSync(join(lane, "simlock-e2e-abc"), { recursive: true });
      mkdirSync(join(lane, "simlock-e2e-def", "gateway"), { recursive: true });
      writeFileSync(
        join(lane, "simlock-e2e-abc", "instance.json"),
        JSON.stringify({ instanceId: "lane-one" }),
      );
      writeFileSync(
        join(lane, "simlock-e2e-def", "gateway", "instance.json"),
        JSON.stringify({ instanceId: "lane-two" }),
      );
    };

    for (const command of ["clean", "stop"]) {
      seedLane();
      writeFileSync(calls, "");
      const result = spawnSync(...scriptCommand(SCRIPT, [command]), {
        cwd: join(dir, "repo"),
        env: { ...env, ...fakeCommandEnv(bin), SIMLOCK_SLOW_DEVICES: devices },
        encoding: "utf8",
        timeout: 60_000,
      });

      expect(result.status, `${command}: ${result.stderr}`).toBe(0);
      const deleted = readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("simctl delete "));
      expect(deleted.sort(), command).toEqual(["simctl delete MINE-1", "simctl delete MINE-2"]);
      expect(existsSync(lane), `${command} removed the lane`).toBe(false);
    }
  });

  forks("clean is refused while a run holds the lock", () => {
    const { lock, run } = machine();
    const runner = idleNode(process.env);
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(runner));

    const result = run("clean");

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(`busy: a slow-lane run holds the lock (pid ${runner})`);
  });

  forks(
    "check stops nothing, keeps the lane's home and passes the lane's own worker while a run holds the lock",
    async () => {
      const { dir, lane, lock, run } = machine();
      mkdirSync(lane, { recursive: true });
      const runner = idleNode(process.env);
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(runner));
      const home = join(lane, "simlock-e2e-abc");
      const daemon = idleNode({ ...process.env, SIMLOCK_HOME: home });
      mkdirSync(join(dir, "worker.lock"));
      writeFileSync(
        join(dir, "worker.lock", "owner.json"),
        JSON.stringify({ folder: home, pid: daemon, startedAt: "t0" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = run("check");

      expect([result.status, result.stderr]).toEqual([0, ""]);
      expect(alive(daemon)).toBe(true);
      expect(existsSync(lane)).toBe(true);
    },
  );

  forks(
    "stop ends the running lane's process group, writes exit 143 to its log and frees the lock",
    () => {
      const { dir, lock, run } = machine();
      const runner = idleNode(process.env, true);
      const log = join(dir, "run.log");
      writeFileSync(log, "");
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(runner));
      writeFileSync(join(lock, "log"), log);

      const result = run("stop");

      expect(result.stdout).toContain(`stopped run ${runner}, log ${log}`);
      expect(alive(runner)).toBe(false);
      expect(readFileSync(`${log}.exit`, "utf8")).toBe("143\n");
      expect(existsSync(lock)).toBe(false);
    },
  );

  it("check exits 69 naming check --fix when the lane has no agent-device of the version package.json pins for @agent-device/proxy, whether it has none or one of another version", () => {
    const { run, tools } = machine({ installed: false });
    const unfit = `unfit: agent-device ${PINNED} is not installed in ${join(tools, `agent-device-${PINNED}`)}; run scripts/slow-e2e.sh check --fix\n`;

    const none = run("check");
    agentDeviceInstall(tools, "0.21.27", PINNED);
    const other = run("check");

    expect([none.status, none.stderr]).toEqual([69, unfit]);
    expect([other.status, other.stderr]).toEqual([69, unfit]);
  });

  it("check --fix installs the pinned agent-device with npm into the lane's tools folder and passes, and a second check --fix runs no npm", () => {
    const { dir, run, runWith, tools } = machine({ installed: false });
    const calls = join(dir, "npm-calls.txt");
    fakeNpm(join(dir, "bin"), calls);
    const folder = join(tools, `agent-device-${PINNED}`);

    const first = runWith(fakeCommandEnv(join(dir, "bin")), "check", "--fix");
    const second = runWith(fakeCommandEnv(join(dir, "bin")), "check", "--fix");

    expect([first.status, first.stderr, first.stdout]).toEqual([
      0,
      "",
      `installed agent-device ${PINNED} into ${folder}\n`,
    ]);
    expect([second.status, second.stderr, second.stdout]).toEqual([0, "", ""]);
    expect(readFileSync(calls, "utf8")).toMatch(
      new RegExp(`^install --prefix .+ agent-device@${PINNED.replaceAll(".", "\\.")}\n$`),
    );
    expect(run("check").status).toBe(0);
    expect(readdirSync(tools)).toEqual([`agent-device-${PINNED}`]);
  });

  it("check --fix exits 69 with npm's error when the install fails, and leaves no folder in the lane's tools", () => {
    const { dir, runWith, tools } = machine({ installed: false });
    mkdirSync(join(dir, "bin"));
    writeFakeCommand(
      join(dir, "bin"),
      "npm",
      '#!/bin/sh\necho "npm error code ENOTFOUND" >&2\nexit 1\n',
    );

    const result = runWith(fakeCommandEnv(join(dir, "bin")), "check", "--fix");

    expect([result.status, result.stderr]).toEqual([
      69,
      `unfit: agent-device ${PINNED} did not install into ${join(tools, `agent-device-${PINNED}`)}: npm error code ENOTFOUND; fix npm or the network, then run scripts/slow-e2e.sh check --fix\n`,
    ]);
    expect(readdirSync(tools)).toEqual([]);
  });

  it("check --fix --dry-run prints the lane home it would remove and the agent-device it would install, and removes and installs nothing", () => {
    const { dir, lane, runWith, tools } = machine({ installed: false });
    const calls = join(dir, "npm-calls.txt");
    fakeNpm(join(dir, "bin"), calls);
    mkdirSync(join(lane, "simlock-e2e-abc"), { recursive: true });
    writeFileSync(join(lane, "simlock-e2e-abc", "disk.img"), Buffer.alloc(3 * 2 ** 20));

    const result = runWith(fakeCommandEnv(join(dir, "bin")), "check", "--fix", "--dry-run");

    expect([result.status, result.stderr, result.stdout]).toEqual([
      0,
      "",
      `would remove ${lane} (3 MiB)\nwould install agent-device ${PINNED} into ${join(tools, `agent-device-${PINNED}`)}\n`,
    ]);
    expect(existsSync(join(lane, "simlock-e2e-abc", "disk.img"))).toBe(true);
    expect(existsSync(tools)).toBe(false);
    expect(readFileSync(calls, "utf8")).toBe("");
  });

  it("check refuses --dry-run without --fix and any other flag with exit 64", () => {
    const { run } = machine();
    const usage = "usage: scripts/slow-e2e.sh check [--fix [--dry-run]]\n";

    expect([run("check", "--dry-run").status, run("check", "--dry-run").stderr]).toEqual([
      64,
      usage,
    ]);
    expect([run("check", "--force").status, run("check", "--force").stderr]).toEqual([64, usage]);
  });

  forks(
    "check --fix --dry-run names a leftover lane worker as one it would stop, leaves it running, and does not report it as a worker holding the machine",
    async () => {
      const { dir, lane, run } = machine();
      const home = join(lane, "simlock-e2e-abc");
      const daemon = idleNode({ ...process.env, SIMLOCK_HOME: home });
      mkdirSync(join(dir, "worker.lock"));
      writeFileSync(
        join(dir, "worker.lock", "owner.json"),
        JSON.stringify({ folder: home, pid: daemon, startedAt: "t0" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = run("check", "--fix", "--dry-run");

      expect([result.status, result.stderr]).toEqual([0, ""]);
      expect(result.stdout).toMatch(new RegExp(`^would stop ${daemon} \\S*node$`, "m"));
      expect(alive(daemon)).toBe(true);
    },
  );

  forks(
    "while a run holds the lock, check --fix runs no npm and exits 69 saying to run it once the lane ends",
    () => {
      const { dir, lock, runWith, tools } = machine({ installed: false });
      const calls = join(dir, "npm-calls.txt");
      fakeNpm(join(dir, "bin"), calls);
      const runner = idleNode(process.env);
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(runner));

      const result = runWith(fakeCommandEnv(join(dir, "bin")), "check", "--fix");

      expect([result.status, result.stderr]).toEqual([
        69,
        `unfit: agent-device ${PINNED} is not installed in ${join(tools, `agent-device-${PINNED}`)}; run scripts/slow-e2e.sh check --fix once the running lane ends\n`,
      ]);
      expect(readFileSync(calls, "utf8")).toBe("");
    },
  );

  forks(
    "a run installs the pinned agent-device when the lane has none and gives its path to the tests as SIMLOCK_E2E_AGENT_DEVICE, over the one the caller set",
    async () => {
      const { dir, runWith, tools } = machine({ installed: false });
      const bin = join(dir, "bin");
      const seen = join(dir, "seen.txt");
      fakeNpm(bin, join(dir, "npm-calls.txt"));
      writeFakeCommand(
        bin,
        "pnpm",
        `#!/bin/sh\nprintf '%s' "$SIMLOCK_E2E_AGENT_DEVICE" > "${seen}"\n`,
      );
      mkdirSync(join(dir, "tmp"));

      const started = runWith({
        ...fakeCommandEnv(bin),
        SIMLOCK_E2E_AGENT_DEVICE: "/somewhere/else/agent-device.mjs",
        TMPDIR: join(dir, "tmp"),
      });
      const log = started.stdout.trim();
      for (let i = 0; i < 100 && !existsSync(`${log}.exit`); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect([started.status, log.startsWith(join(dir, "tmp"))]).toEqual([0, true]);
      expect(readFileSync(seen, "utf8")).toBe(
        join(
          tools,
          `agent-device-${PINNED}`,
          "node_modules",
          "agent-device",
          "bin",
          "agent-device.mjs",
        ),
      );
    },
  );

  it("the default worker lock path in the script is the one the daemon takes for the current user", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const uid = process.getuid?.() ?? 0;

    const text = /SIMLOCK_SLOW_WORKER_LOCK:-([^}]+)\}/.exec(script)?.[1];

    expect(text?.replace("$(id -u)", String(uid))).toBe(
      defaultWorkerLockPath("linux", uid, tmpdir()),
    );
  });

  forks(
    "check and a run exit 69 with the not fit message, freeing the lane lock, while a live pid holds the worker lock; a stale holder lets them go on",
    () => {
      const { dir, env, run } = machine();
      const holderFolder = "/home/other/.simlock";
      const lockFolder = join(dir, "worker.lock");
      mkdirSync(lockFolder);
      const owner = (pid: number) =>
        writeFileSync(
          join(lockFolder, "owner.json"),
          JSON.stringify({ folder: holderFolder, pid, startedAt: "t0" }),
        );
      const pid = idleNode(env);
      owner(pid);
      const refusal = `not fit: a Simlock worker holds this machine (pid ${pid}, folder ${holderFolder}); stop it first: SIMLOCK_HOME=${holderFolder} simlock daemon stop\n`;

      const check = run("check");
      const started = run();
      owner(2_147_483_646);
      const stale = run("check");

      expect([check.status, check.stderr]).toEqual([69, refusal]);
      expect([started.status, started.stderr]).toEqual([69, refusal]);
      expect(existsSync(env.SIMLOCK_SLOW_LOCK)).toBe(false);
      expect([stale.status, stale.stderr]).toEqual([0, ""]);
    },
  );
});
