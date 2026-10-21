import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { freeLoopbackPort, REPO_ROOT, type TestEnv, waitFor, withDaemon } from "./helpers/index.js";

function runDaemonEntry(env: TestEnv, args: readonly string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "dist/daemon/main.js"), ...args], {
      env: env.env,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

describe("daemon lifecycle & recovery", () => {
  it.each([
    { role: "worker", args: [], folder: "" },
    { role: "gateway", args: ["--gateway"], folder: "gateway" },
  ])(
    "a service manager sends SIGTERM to a running $role daemon: it stops cleanly, emits daemon.stopping reason signal, removes admin.token, exits 0",
    async ({ args, folder }) => {
      const env = await withDaemon({ mode: "auto" });
      if (args.length > 0) {
        const port = await freeLoopbackPort();
        const set = await env.cli(["--gateway", "config", "set", "http.port", String(port)]);
        expect(set.code, set.stderr).toBe(0);
      }
      const directory = join(env.home, folder);
      const child = spawn(process.execPath, [join(REPO_ROOT, "dist/daemon/main.js"), ...args], {
        env: env.env,
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      try {
        await waitFor(() => existsSync(join(directory, "admin.token")), {
          label: "the daemon's admin.token written",
        });

        child.kill("SIGTERM");
        const code = await exited;

        expect(code).toBe(0);
        expect(existsSync(join(directory, "admin.token"))).toBe(false);
        expect(await readFile(join(directory, "daemon.log"), "utf8")).toContain(
          '"message":"Daemon stopping"',
        );
        expect(await readFile(join(directory, "daemon.log"), "utf8")).toContain(
          '"reason":"signal"',
        );
      } finally {
        child.kill("SIGKILL");
      }
    },
    60_000,
  );

  it("SIGTERM before startup finishes exits 0 at once instead of waiting for the start", async () => {
    const env = await withDaemon({ mode: "auto" });
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["26.0"],
        knownModels: ["iPhone 16"],
        latencyMs: { listManaged: 20_000 },
      },
    });
    const child = spawn(process.execPath, [join(REPO_ROOT, "dist/daemon/main.js")], {
      env: env.env,
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    try {
      await waitFor(() => existsSync(join(env.home, "admin.token")), {
        label: "the daemon's admin.token written, startup still held",
      });

      const sentAt = Date.now();
      child.kill("SIGTERM");
      const code = await exited;

      expect(code).toBe(0);
      expect(Date.now() - sentAt).toBeLessThan(10_000);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  it("a daemon that stops for a failure exits 1; one that finds another daemon answering exits 0", async () => {
    const env = await withDaemon({ mode: "auto" });

    await env.startDaemon();
    const beside = await runDaemonEntry(env, []);
    expect(beside).toBe(0);
    expect(await readFile(env.logPath, "utf8")).toContain('"message":"Daemon already running"');
    const status = await env.cli(["daemon", "status", "--json"]);
    expect(status.json).toMatchObject({ daemon: { health: "running", mode: "worker" } });

    await env.cli(["daemon", "stop"]);
    await waitFor(() => !existsSync(env.socketPath), { label: "the worker stopped" });
    const history = new DatabaseSync(join(env.home, "history.db"));
    try {
      history.exec("UPDATE projection_versions SET version = 99 WHERE name = 'usage'");
    } finally {
      history.close();
    }
    expect(await runDaemonEntry(env, [])).toBe(1);

    const holder = createServer();
    const port = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    try {
      const set = await env.cli(["--gateway", "config", "set", "http.port", String(port)]);
      expect(set.code, set.stderr).toBe(0);
      expect(await runDaemonEntry(env, ["--gateway"])).toBe(1);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 60_000);

  it("auto-starts on the first CLI call, reports status, and does not double-spawn", async () => {
    const env = await withDaemon({ mode: "auto" });

    expect(existsSync(env.socketPath)).toBe(false);

    const catalog = await env.cli(["catalog", "--json"]);
    expect(catalog.code).toBe(0);
    await waitFor(() => existsSync(env.socketPath), { label: "daemon.sock created by auto-start" });

    const statusJson = await env.cli(["daemon", "status", "--json"]);
    expect(statusJson.code).toBe(0);
    expect(statusJson.json).toMatchObject({ daemon: { health: "running", mode: "worker" } });

    // "daemon start" while already running must not spawn a second daemon: the
    // request-scoped connection each `daemon start` opens transiently would make a
    // pid comparison via lsof racy, so compare content of daemon.log instead --
    // a second daemon process would append its own "Daemon started" record.
    const before = await readFile(env.logPath, "utf8");
    const startedCountBefore = countOccurrences(before, "Daemon started");
    const secondStart = await env.cli(["daemon", "start"]);
    expect(secondStart.code).toBe(0);
    const after = await readFile(env.logPath, "utf8");
    expect(countOccurrences(after, "Daemon started")).toBe(startedCountBefore);
    expect(existsSync(join(env.home, "gateway"))).toBe(false);
  });

  it("recovers from a kill -9 that leaves a stale socket behind", async () => {
    const env = await withDaemon({ mode: "running" });
    expect(existsSync(env.socketPath)).toBe(true);

    await env.killDaemon("SIGKILL");
    // kill -9 does not unlink the unix socket file -- it should still exist, stale.
    expect(existsSync(env.socketPath)).toBe(true);

    // `daemon status` deliberately never auto-starts (checking status shouldn't have
    // the side effect of spawning a daemon) -- any other command does, and is how a
    // real agent would recover from a stale socket left by a crash.
    const catalog = await env.cli(["catalog", "--json"]);
    expect(catalog.code).toBe(0);

    const status = await env.cli(["daemon", "status", "--json"]);
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({ daemon: { health: "running" } });
  });

  it("daemon status prints a human-oriented view by default", async () => {
    const env = await withDaemon({ mode: "running" });

    const statusHuman = await env.cli(["daemon", "status"]);
    expect(statusHuman.code).toBe(0);
    expect(statusHuman.stdout.split("\n")[0]).toBe("Daemon: running (worker)");
  });

  it("stops while a detached lease is still outstanding", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--agent-id",
      "outliving-agent",
      "--detach",
    ]);
    expect(lease.code).toBe(0);

    // A detached lease is deliberately left alone by shutdown -- its liveness is the TTL,
    // not a connection -- and its armed TTL timer used to keep the process alive for the
    // full fifteen minutes after `daemon stop` returned. Teardown's stray-process check is
    // the assertion: it fails the test if the daemon that was told to stop is still there.
    const stop = await env.cli(["daemon", "stop"]);
    expect(stop.code).toBe(0);
    await waitFor(() => !existsSync(env.socketPath), {
      timeout: 10_000,
      label: "daemon socket removed",
    });
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
