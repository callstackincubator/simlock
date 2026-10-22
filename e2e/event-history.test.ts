import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readHistoryEvents } from "../src/history/testing.js";
import { type TestEnv, waitFor, withDaemon } from "./helpers/index.js";

interface Envelope {
  readonly id: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly module: string;
}

async function prepare(env: TestEnv): Promise<void> {
  await env.driverScript.set({
    ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
  });
}

async function leaseDevice(env: TestEnv): Promise<string> {
  const lease = await env.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--detach",
  ]);
  expect(lease.code).toBe(0);
  return (lease.json as { lease: { id: string } }).lease.id;
}

function parseLines(contents: string): Envelope[] {
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Envelope);
}

async function eventFile(env: TestEnv): Promise<Envelope[]> {
  return (await readHistoryEvents(env.home)) as unknown as Envelope[];
}

async function stopDaemon(env: TestEnv): Promise<void> {
  await env.cli(["daemon", "stop"]);
  await waitFor(() => !existsSync(env.socketPath), { label: "daemon socket removed" });
}

function grantOf(events: readonly Envelope[], leaseId: string): Envelope | undefined {
  return events.find(
    (entry) => entry.event === "lease.granted" && entry.payload.leaseId === leaseId,
  );
}

describe("event history", () => {
  it("prints a lease granted before a daemon restart with its id with simlock events --since 1h, with the daemon running and with it stopped", async () => {
    const env = await withDaemon();
    await prepare(env);
    const leaseId = await leaseDevice(env);
    const before = grantOf(await eventFile(env), leaseId);
    expect(before?.id).toMatch(/^evt_[A-Za-z0-9_-]{1,64}$/);

    await env.restartDaemon();
    const running = await env.cli(["events", "--since", "1h"]);
    await stopDaemon(env);
    const stopped = await env.cli(["events", "--since", "1h"]);

    expect(running.code).toBe(0);
    expect(grantOf(parseLines(running.stdout), leaseId)).toEqual(before);
    expect(stopped.code).toBe(0);
    expect(grantOf(parseLines(stopped.stdout), leaseId)).toEqual(before);
    expect(existsSync(env.socketPath)).toBe(false);
    const status = await env.cli(["daemon", "status", "--json"]);
    expect(status.json).toMatchObject({ status: "stopped" });
  });

  it("simlock events --since 1h after a daemon restart prints each event with the id it had before the restart", async () => {
    const env = await withDaemon();
    await prepare(env);
    const leaseId = await leaseDevice(env);
    const beforeRestart = parseLines((await env.cli(["events", "--since", "1h"])).stdout);
    const granted = grantOf(beforeRestart, leaseId);
    expect(granted?.id).toMatch(/^evt_[A-Za-z0-9_-]{1,64}$/);

    await env.restartDaemon();
    const afterRestart = parseLines((await env.cli(["events", "--since", "1h"])).stdout);

    for (const before of beforeRestart) {
      expect(before.id).toMatch(/^evt_/);
      expect(afterRestart.find((entry) => entry.id === before.id)).toEqual(before);
    }
    expect(new Set(afterRestart.map((entry) => entry.id)).size).toBe(afterRestart.length);
  });

  it("shows lease.granted with the requestId of the preceding lease.requested, provisioned for a first lease and warm for the next on the same device", async () => {
    const env = await withDaemon();
    await prepare(env);
    const firstId = await leaseDevice(env);
    expect((await env.cli(["release", firstId])).code).toBe(0);
    const secondId = await leaseDevice(env);

    const history = parseLines((await env.cli(["events", "--since", "1h"])).stdout);

    const granted = [firstId, secondId].map((leaseId) => grantOf(history, leaseId));
    const requested = history.filter((entry) => entry.event === "lease.requested");
    expect(requested).toHaveLength(2);
    for (const [index, grant] of granted.entries()) {
      const request = requested[index];
      expect(request?.payload.requestId).toMatch(/^req_/);
      expect(grant?.payload.requestId).toBe(request?.payload.requestId);
      expect(history.indexOf(request as Envelope)).toBeLessThan(history.indexOf(grant as Envelope));
    }
    expect(granted.map((grant) => grant?.payload.source)).toEqual(["provisioned", "warm"]);
    expect(granted[0]?.payload.deviceId).toEqual(expect.any(String));
    expect(granted[1]?.payload.deviceId).toBe(granted[0]?.payload.deviceId);
  });

  it("shows capacity.changed and queue.changed from daemon start, never two in a row with equal payloads", async () => {
    const env = await withDaemon();
    await prepare(env);
    const leaseId = await leaseDevice(env);
    expect((await env.cli(["release", leaseId])).code).toBe(0);

    const history = parseLines((await env.cli(["events", "--since", "1h"])).stdout);

    for (const name of ["capacity.changed", "queue.changed"]) {
      const payloads = history
        .filter((entry) => entry.event === name)
        .map((entry) => entry.payload);
      expect(payloads.length).toBeGreaterThan(0);
      payloads.slice(1).forEach((payload, index) => expect(payload).not.toEqual(payloads[index]));
    }
    const firstCapacity = history.findIndex((entry) => entry.event === "capacity.changed");
    expect(firstCapacity).toBeLessThan(
      history.findIndex((entry) => entry.event === "lease.requested"),
    );
    expect(history.find((entry) => entry.event === "queue.changed")?.payload).toEqual({ depth: 0 });
  });

  it("writes history.db and no events.jsonl in a fresh data directory, and leaves an events.jsonl placed there before the start byte-identical", async () => {
    const fresh = await withDaemon();
    const placed = await withDaemon({ mode: "auto" });
    const legacy = Buffer.from(
      `${JSON.stringify({ id: "evt_old", seq: 1, timestamp: 1 })}\nnot json\n`,
    );
    await writeFile(join(placed.home, "events.jsonl"), legacy);

    await placed.startDaemon();

    await waitFor(() => existsSync(join(fresh.home, "history.db")), {
      label: "history.db written",
      timeout: 10_000,
    });
    expect(existsSync(join(fresh.home, "events.jsonl"))).toBe(false);
    await waitFor(() => existsSync(join(placed.home, "history.db")), {
      label: "history.db written",
      timeout: 10_000,
    });
    expect(await readFile(join(placed.home, "events.jsonl"))).toEqual(legacy);
  });

  it("with eventLog.retention a few seconds, events of a first run are gone after the next start's prune, and a second run's are there", async () => {
    const env = await withDaemon({ configOverrides: { eventLog: { retention: 5_000 } } });
    await prepare(env);
    const firstLeaseId = await leaseDevice(env);
    expect(grantOf(await eventFile(env), firstLeaseId)).toBeDefined();
    await stopDaemon(env);
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    await env.startDaemon();
    const secondLeaseId = await leaseDevice(env);

    const history = await eventFile(env);
    expect(grantOf(history, firstLeaseId)).toBeUndefined();
    expect(grantOf(history, secondLeaseId)).toBeDefined();
  }, 60_000);

  it("a history.db overwritten with junk while the daemon is stopped is renamed aside at the next start, a lease is granted, and simlock status prints the set-aside line", async () => {
    const env = await withDaemon();
    await prepare(env);
    await leaseDevice(env);
    await stopDaemon(env);
    const junk = "this is not a sqlite database ".repeat(20);
    await writeFile(join(env.home, "history.db"), junk);

    await env.startDaemon();
    const leaseId = await leaseDevice(env);

    const status = await env.cli(["status"]);
    const aside = (await readdir(env.home)).filter((name) =>
      /^history\.db\.damaged-\d+$/.test(name),
    );
    expect(status.stdout).toContain("History: the event history was damaged and set aside at ");
    expect(aside).toHaveLength(1);
    expect(await readFile(join(env.home, aside[0]!), "utf8")).toBe(junk);
    expect(grantOf(await eventFile(env), leaseId)).toBeDefined();
  });

  it("the daemon and the CLI print no ExperimentalWarning for SQLite, and another warning still prints", async () => {
    const env = await withDaemon({ mode: "auto" });
    const warner = join(env.home, "warn.cjs");
    await writeFile(warner, 'process.emitWarning("simlock-e2e-other-warning");\n');
    const options = { env: { NODE_OPTIONS: `--require ${warner}` } };

    await env.cli(["daemon", "start"], options);
    await waitFor(() => existsSync(join(env.home, "history.db")), {
      label: "history.db written",
      timeout: 10_000,
    });
    await waitFor(
      async () => (await readFile(env.logPath, "utf8")).includes("simlock-e2e-other-warning"),
      {
        label: "the daemon's other warning in daemon.log",
      },
    );
    await stopDaemon(env);
    const events = await env.cli(["events", "--since", "1h"], options);

    const daemonLog = await readFile(env.logPath, "utf8");
    expect(daemonLog).not.toContain("SQLite is an experimental feature");
    expect(events.code).toBe(0);
    expect(events.stderr).toContain("simlock-e2e-other-warning");
    expect(events.stderr).not.toContain("SQLite is an experimental feature");
  });

  it("keeps every emitted event in the event file after daemon.log rotates", async () => {
    const env = await withDaemon({ configOverrides: { log: { rotateBytes: 1024 } } });
    await prepare(env);
    for (let round = 0; round < 3; round++) {
      const leaseId = await leaseDevice(env);
      expect((await env.cli(["release", leaseId])).code).toBe(0);
    }
    expect(existsSync(`${env.logPath}.1`)).toBe(true);

    // The ring holds every event this daemon emitted; the file must hold each of them.
    const ring = await env.cli(["events"]);
    expect(ring.code).toBe(0);
    const emitted = parseLines(ring.stdout);
    const onDisk = new Set(
      (await eventFile(env)).map((entry) => `${entry.seq}:${entry.timestamp}`),
    );

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.filter((entry) => !onDisk.has(`${entry.seq}:${entry.timestamp}`))).toEqual([]);
  });
});
