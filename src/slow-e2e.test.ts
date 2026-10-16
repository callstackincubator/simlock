import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "slow-e2e.sh");
const PINNED = "0.21.28";

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

function machine() {
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
    SIMLOCK_E2E_AGENT_DEVICE: "",
  };
  const run = (...args: string[]) =>
    spawnSync("sh", [SCRIPT, ...args], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  return { dir, repo, env, run, lock: env.SIMLOCK_SLOW_LOCK, lane: env.SIMLOCK_SLOW_TMP };
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

  it("clean stops a process whose environment names the lane's home, removes the home, and leaves other processes alone", async () => {
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
  });

  it("clean is refused while a run holds the lock", () => {
    const { lock, run } = machine();
    const runner = idleNode(process.env);
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(runner));

    const result = run("clean");

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(`busy: a slow-lane run holds the lock (pid ${runner})`);
  });

  it("stop ends the running lane's process group, writes exit 143 to its log and frees the lock", () => {
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
  });

  function agentDeviceInstall(dir: string, version: string): string {
    const install = join(dir, "agent-device");
    mkdirSync(join(install, "bin"), { recursive: true });
    mkdirSync(join(install, "dist"));
    writeFileSync(join(install, "package.json"), JSON.stringify({ name: "agent-device", version }));
    return join(install, "bin", "agent-device.mjs");
  }

  it("check refuses an agent-device install of another version than package.json pins for @agent-device/proxy", () => {
    const { dir, env, repo } = machine();

    const result = spawnSync("sh", [SCRIPT, "check"], {
      cwd: repo,
      env: { ...env, SIMLOCK_E2E_AGENT_DEVICE: agentDeviceInstall(dir, "0.21.27") },
      encoding: "utf8",
    });

    expect(result.status).toBe(69);
    expect(result.stderr).toBe(
      `unfit: SIMLOCK_E2E_AGENT_DEVICE is agent-device 0.21.27; package.json pins ${PINNED}\n`,
    );
  });

  it("check passes an agent-device install of the version package.json pins", () => {
    const { dir, env, repo } = machine();

    const result = spawnSync("sh", [SCRIPT, "check"], {
      cwd: repo,
      env: { ...env, SIMLOCK_E2E_AGENT_DEVICE: agentDeviceInstall(dir, PINNED) },
      encoding: "utf8",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
