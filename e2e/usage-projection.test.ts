import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type DeviceFactRow, openUsageReads, type RequestRow } from "../src/history/index.js";
import { NodeSqliteOpener } from "../src/ports/index.js";
import { type TestEnv, waitFor, withDaemon } from "./helpers/index.js";

const LEASE_ARGS = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;
const ALL = Number.MAX_SAFE_INTEGER;
const MINUTE = 60_000;
const SEEDED = 300_000;

async function prepare(env: TestEnv): Promise<void> {
  await env.driverScript.set({
    ios: {
      knownModels: ["iPhone 16"],
      availableOsVersions: ["18.4"],
      latencyMs: { makeReady: 50 },
    },
  });
}

async function usageOf(env: TestEnv): Promise<{
  readonly requests: RequestRow[];
  readonly facts: DeviceFactRow[];
  readonly minutes: ReturnType<ReturnType<typeof openUsageReads>["minuteBuckets"]>;
  readonly oldest: number | undefined;
}> {
  const database = await new NodeSqliteOpener().open(join(env.home, "history.db"), {
    readOnly: true,
  });
  try {
    const reads = openUsageReads(database);
    const oldest = reads.oldestTs();
    const from = oldest === undefined ? 0 : oldest - (oldest % MINUTE);
    return {
      facts: reads.deviceFacts({ from: 0, to: ALL }),
      minutes: reads.minuteBuckets({
        bucketMs: MINUTE,
        from,
        platform: "ios",
        to: from + 5 * MINUTE,
        workerId: "",
      }),
      oldest: reads.oldestTs(),
      requests: reads.requestRows({ from: 0, to: ALL }),
    };
  } finally {
    database.close();
  }
}

async function stopDaemon(env: TestEnv): Promise<void> {
  await env.cli(["daemon", "stop"]);
  await waitFor(() => !existsSync(env.socketPath), { label: "daemon socket removed" });
}

async function editHistory(env: TestEnv, ...statements: string[]): Promise<void> {
  const database = await new NodeSqliteOpener().open(join(env.home, "history.db"), {
    readOnly: false,
  });
  try {
    for (const statement of statements) database.exec(statement);
  } finally {
    database.close();
  }
}

describe("usage projection", () => {
  it("after a scripted run on the fake driver, a daemon stop and start, the request rows match the requests simlock events --since 1h counts, and the same rows are there after the restart", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } },
    });
    await prepare(env);
    const first = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(first.code).toBe(0);
    const noWait = await env.cli([...LEASE_ARGS, "--agent-id", "agent-b", "--no-wait", "--detach"]);
    expect(noWait.code).toBe(11);
    const timedOut = await env.cli(
      [...LEASE_ARGS, "--agent-id", "agent-c", "--timeout", "300ms", "--detach"],
      { timeout: 15_000 },
    );
    expect(timedOut.code).toBe(10);
    expect(
      (await env.cli(["release", (first.json as { lease: { id: string } }).lease.id])).code,
    ).toBe(0);
    const before = await usageOf(env);

    await env.restartDaemon();
    const after = await usageOf(env);

    const printed = await env.cli(["events", "--since", "1h"]);
    expect(printed.code).toBe(0);
    const history = printed.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly event: string;
            readonly timestamp: number;
            readonly payload: { readonly requestId?: string };
          },
      );
    const requested = history.filter((entry) => entry.event === "lease.requested");
    expect(requested).toHaveLength(3);
    expect(before.requests).toHaveLength(3);
    expect(before.requests.map((row) => [row.requestId, row.requestedAt]).sort()).toEqual(
      requested.map((entry) => [entry.payload.requestId, entry.timestamp]).sort(),
    );
    expect(before.requests.filter((row) => row.grantedAt !== undefined)).toHaveLength(1);
    expect(before.requests.filter((row) => row.reason === "no-wait")).toHaveLength(1);
    expect(before.requests.filter((row) => row.reason === "timeout")).toHaveLength(1);
    expect(before.facts.map((fact) => fact.kind)).toEqual(
      expect.arrayContaining(["device.provisioned", "device.ready"]),
    );
    expect(before.oldest).toBeDefined();
    expect(before.minutes.length).toBeGreaterThan(0);
    expect(before.minutes.some((bucket) => (bucket.slotsUsed?.peak ?? 0) >= 1)).toBe(true);
    expect(after.requests).toEqual(before.requests);
    expect(after.facts).toEqual(before.facts);
  }, 90_000);

  it("with eventLog.retention a few seconds the first run's request rows are still there after the next start, and with metrics.retention also short they are gone", async () => {
    const kept = await withDaemon({ configOverrides: { eventLog: { retention: 5_000 } } });
    const dropped = await withDaemon({
      configOverrides: { eventLog: { retention: 5_000 }, metrics: { retention: 5_000 } },
    });
    const firstRows: Record<string, string> = {};
    for (const [name, env] of [
      ["kept", kept],
      ["dropped", dropped],
    ] as const) {
      await prepare(env);
      const lease = await env.cli([...LEASE_ARGS, "--detach"]);
      expect(lease.code).toBe(0);
      firstRows[name] = (await usageOf(env)).requests[0]?.requestId ?? "";
      await stopDaemon(env);
    }
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    for (const env of [kept, dropped]) {
      await env.startDaemon();
      expect((await env.cli([...LEASE_ARGS, "--agent-id", "second", "--detach"])).code).toBe(0);
    }

    const keptIds = (await usageOf(kept)).requests.map((row) => row.requestId);
    const droppedIds = (await usageOf(dropped)).requests.map((row) => row.requestId);
    expect(firstRows.kept).toMatch(/^req_/);
    expect(keptIds).toContain(firstRows.kept);
    expect(keptIds).toHaveLength(2);
    expect(droppedIds).not.toContain(firstRows.dropped);
    expect(droppedIds).toHaveLength(1);
  }, 90_000);

  it("a history.db whose projection table lost a column while the daemon was stopped is rebuilt at the next start, a lease is granted meanwhile, and simlock status prints the rebuilt line", async () => {
    const env = await withDaemon();
    await prepare(env);
    expect((await env.cli([...LEASE_ARGS, "--agent-id", "a", "--detach"])).code).toBe(0);
    const before = (await usageOf(env)).requests;
    await stopDaemon(env);
    // why: enough kept events that the rebuild is still running when the daemon answers and a lease is granted.
    const now = Date.now();
    await editHistory(
      env,
      "ALTER TABLE request_rows DROP COLUMN heldMs",
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SEEDED})
       INSERT INTO events (id, timestamp, seq, size, envelope)
       SELECT 'evt_seed_' || i, ${now - 60_000} + i % 1000, i, 200,
         json_object('id', 'evt_seed_' || i, 'event', 'lease.requested', 'module', 'leasing',
           'seq', i, 'timestamp', ${now - 60_000} + i % 1000,
           'payload', json_object('requestId', 'seed_' || i,
             'requestSpec', json_object('platform', 'ios'), 'requester', 'seed',
             'waitPolicy', 'wait'))
       FROM n`,
    );

    await env.startDaemon();
    expect((await env.cli([...LEASE_ARGS, "--agent-id", "b", "--detach"])).code).toBe(0);
    const meanwhile = await env.cli(["status"]);

    expect(meanwhile.stdout).not.toContain("History: figures were rebuilt");
    await waitFor(async () => (await env.cli(["status"])).stdout.includes("figures were rebuilt"), {
      label: "history rebuilt",
      timeout: 60_000,
    });
    const status = await env.cli(["status"]);
    const after = (await usageOf(env)).requests;
    expect(status.stdout).toContain("History: figures were rebuilt from the event history at ");
    expect(after.map((row) => row.requestId)).toEqual(
      expect.arrayContaining(before.map((row) => row.requestId)),
    );
    expect(after).toHaveLength(SEEDED + 2);
  }, 120_000);

  it("a history.db with a newer stored projection version makes simlock daemon start fail with exit 1 and leaves the file's rows unchanged", async () => {
    const env = await withDaemon();
    await prepare(env);
    expect((await env.cli([...LEASE_ARGS, "--detach"])).code).toBe(0);
    await stopDaemon(env);
    await editHistory(env, "UPDATE projection_versions SET version = 99 WHERE name = 'usage'");
    const before = (await usageOf(env)).requests;

    const started = await env.cli(["daemon", "start"]);

    const database = await new NodeSqliteOpener().open(join(env.home, "history.db"), {
      readOnly: true,
    });
    try {
      expect(started.code).toBe(1);
      expect(
        database.prepare("SELECT version FROM projection_versions WHERE name = 'usage'").get()
          ?.version,
      ).toBe(99);
    } finally {
      database.close();
    }
    expect((await usageOf(env)).requests).toEqual(before);
    expect(existsSync(env.socketPath)).toBe(false);
  }, 90_000);
});
