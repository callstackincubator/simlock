import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

describe("daemon lifecycle & recovery", () => {
  it("auto-starts on the first CLI call, reports status, and does not double-spawn", async () => {
    const env = await withDaemon({ mode: "auto" });

    expect(existsSync(env.socketPath)).toBe(false);

    const catalog = await env.cli(["catalog", "--json"]);
    expect(catalog.code).toBe(0);
    await waitFor(() => existsSync(env.socketPath), { label: "daemon.sock created by auto-start" });

    const statusJson = await env.cli(["daemon", "status", "--json"]);
    expect(statusJson.code).toBe(0);
    expect(statusJson.json).toMatchObject({ health: "running" });

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
    expect(status.json).toMatchObject({ health: "running" });
  });

  // Suspected bug: `simlock daemon status` always writes raw JSON via `writeResult`
  // (src/cli/index.ts `runDaemon`, the "status" branch) regardless of `--json`,
  // unlike its siblings `daemon start`/`daemon stop` which both branch on
  // `values.json` to print "Daemon running"/"Daemon stopping" in human mode. This
  // contradicts docs/CLI.md ("`daemon <start|stop|status|logs>` ... default to a
  // human-oriented view ... and accept `--json`"). See final report.
  it.fails("daemon status prints a human-oriented view by default", async () => {
    const env = await withDaemon({ mode: "running" });

    const statusHuman = await env.cli(["daemon", "status"]);
    expect(statusHuman.code).toBe(0);
    expect(statusHuman.stdout).toContain("Daemon running");
  });

  it("writes the documented structured startup lines to daemon.log", async () => {
    const env = await withDaemon({ mode: "running" });

    const contents = await readFile(env.logPath, "utf8");
    const lines = contents
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.length, "daemon.log is empty after startup -- see report").toBeGreaterThan(0);

    const startRecord = lines.find((line) => line.message === "Daemon started");
    expect(startRecord, "no 'Daemon started' record in daemon.log").toBeDefined();
    expect(startRecord).toMatchObject({
      fields: expect.objectContaining({
        version: expect.any(String),
        protocolVersion: expect.any(Number),
        socketPath: env.socketPath,
      }),
    });

    const modules = new Set(lines.map((line) => line.module));
    expect(modules.has("daemon.driver-discovery"), "no driver-discovery log lines").toBe(true);
    expect(modules.has("daemon.connection-host"), "no connection-host log lines").toBe(true);
  });

  it("rotates daemon.log to daemon.log.1 once past config.log.rotateBytes", async () => {
    const env = await withDaemon({ mode: "auto" });

    await env.withConfig({ log: { rotateBytes: 200 } }, async () => {
      await waitFor(() => existsSync(`${env.logPath}.1`), {
        timeout: 15_000,
        label: "daemon.log.1 created after low rotateBytes",
      });
      expect(existsSync(env.logPath)).toBe(true);
    });
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
