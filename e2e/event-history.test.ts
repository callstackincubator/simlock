import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
  const path = join(env.home, "events.jsonl");
  let rotated = "";
  for (let generation = 1; existsSync(`${path}.${generation}`); generation++) {
    rotated = (await readFile(`${path}.${generation}`, "utf8")) + rotated;
  }
  return parseLines(rotated + (await readFile(path, "utf8")));
}

function grantOf(events: readonly Envelope[], leaseId: string): Envelope | undefined {
  return events.find(
    (entry) => entry.event === "lease.granted" && entry.payload.leaseId === leaseId,
  );
}

describe("event history", () => {
  it("prints a lease granted before a daemon restart with simlock events --since 1h after it", async () => {
    const env = await withDaemon();
    await prepare(env);
    const leaseId = await leaseDevice(env);
    const before = grantOf(await eventFile(env), leaseId);
    expect(before).toBeDefined();

    await env.restartDaemon();
    const history = await env.cli(["events", "--since", "1h"]);

    expect(history.code).toBe(0);
    expect(grantOf(parseLines(history.stdout), leaseId)).toEqual(before);
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

  it("prints the history with the daemon stopped, and the daemon stays stopped", async () => {
    const env = await withDaemon();
    await prepare(env);
    const leaseId = await leaseDevice(env);
    await env.cli(["daemon", "stop"]);
    await waitFor(() => !existsSync(env.socketPath), { label: "daemon socket removed" });

    const history = await env.cli(["events", "--since", "1h"]);

    expect(history.code).toBe(0);
    expect(grantOf(parseLines(history.stdout), leaseId)).toBeDefined();
    expect(existsSync(env.socketPath)).toBe(false);
    const status = await env.cli(["daemon", "status", "--json"]);
    expect(status.json).toEqual({ status: "stopped" });
  });

  it("keeps no more than two generations beside events.jsonl when eventLog.maxBytes is twice eventLog.rotateBytes, holding the newest event", async () => {
    const rotateBytes = 2 * 1024;
    const env = await withDaemon({
      configOverrides: { eventLog: { maxBytes: 2 * rotateBytes, rotateBytes } },
    });
    await prepare(env);
    let lastLeaseId = "";
    for (let round = 0; round < 12; round++) {
      lastLeaseId = await leaseDevice(env);
      expect((await env.cli(["release", lastLeaseId])).code).toBe(0);
    }

    const path = join(env.home, "events.jsonl");
    await waitFor(
      async () =>
        (await eventFile(env)).some(
          (entry) => entry.event === "lease.released" && entry.payload.leaseId === lastLeaseId,
        ),
      { label: "the last release in the event file" },
    );
    expect(existsSync(`${path}.1`)).toBe(true);
    const beside = (await readdir(env.home)).filter((name) => /^events\.jsonl\.\d+$/.test(name));
    expect(beside.length).toBeLessThanOrEqual(2);
    let total = (await stat(path)).size;
    for (const name of beside) total += (await stat(join(env.home, name))).size;
    expect(total).toBeLessThanOrEqual(3 * rotateBytes);
  });

  it("simlock events --since 7d with the daemon stopped reads events from a generation older than .1", async () => {
    const env = await withDaemon({ configOverrides: { eventLog: { rotateBytes: 2 * 1024 } } });
    await prepare(env);
    const firstLeaseId = await leaseDevice(env);
    expect((await env.cli(["release", firstLeaseId])).code).toBe(0);
    for (let round = 0; round < 6; round++) {
      expect((await env.cli(["release", await leaseDevice(env)])).code).toBe(0);
    }
    const path = join(env.home, "events.jsonl");
    expect(existsSync(`${path}.3`)).toBe(true);
    await env.cli(["daemon", "stop"]);
    await waitFor(() => !existsSync(env.socketPath), { label: "daemon socket removed" });

    const history = await env.cli(["events", "--since", "7d"]);

    expect(history.code).toBe(0);
    expect(grantOf(parseLines(history.stdout), firstLeaseId)).toBeDefined();
    const ids = parseLines(history.stdout).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
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
