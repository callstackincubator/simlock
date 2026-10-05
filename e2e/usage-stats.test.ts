import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { RecordedEvent } from "./helpers/events.js";

/**
 * ADR 0016 with real processes: `simlock stats` reads the figures from the event history, on a
 * worker and on a gateway, and the figures are what a reader counts by hand from `simlock
 * events` for the same window.
 */

const LEASE_ARGS = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

interface Samples {
  readonly count: number;
  readonly max: number | null;
  readonly p50: number | null;
}

interface Figures {
  readonly requests: number;
  readonly granted: number;
  readonly bySource: Record<string, number>;
  readonly rejected: { readonly total: number; readonly byReason: Record<string, number> };
  readonly wait: Samples;
  readonly held: Samples;
  readonly turnaround: Samples;
  readonly provisioning: Samples;
  readonly boot: Samples;
  readonly incidents: Record<string, number>;
}

interface Usage {
  readonly window: { readonly from: number; readonly to: number };
  readonly partial: boolean;
  readonly coversFrom: number;
  readonly totals: Figures;
  readonly workers: readonly (Figures & { readonly id: string; readonly label?: string })[];
  readonly requesters: readonly { readonly id: string; readonly requests: number }[];
}

async function stats(
  env: { cli: (args: string[]) => Promise<{ code: number | null; json?: unknown }> },
  since = "1h",
): Promise<Usage> {
  const result = await env.cli(["stats", "--since", since, "--json"]);
  expect(result.code).toBe(0);
  return result.json as Usage;
}

/**
 * The figures once the window has closed over the newest event: the window is rounded down to the
 * series bucket, so what happened in the minute now running is counted when the minute is over.
 */
async function settledStats(
  env: {
    cli: (args: string[]) => Promise<{ code: number | null; json?: unknown }>;
    events: () => Promise<readonly RecordedEvent[]>;
  },
  until: (usage: Usage) => boolean = () => true,
): Promise<Usage> {
  let usage: Usage | undefined;
  await waitFor(
    async () => {
      const newest = Math.max(...(await env.events()).map((event) => event.timestamp));
      usage = await stats(env);
      return usage.window.to >= newest && until(usage);
    },
    { interval: 1_000, label: "the window closed over the newest event", timeout: 90_000 },
  );
  return usage as Usage;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function inWindow(events: readonly RecordedEvent[], window: Usage["window"]): RecordedEvent[] {
  return events.filter((event) => event.timestamp > window.from && event.timestamp <= window.to);
}

function payload(event: RecordedEvent): Record<string, string> {
  return event.payload as Record<string, string>;
}

describe("simlock stats", () => {
  it("after a scripted run of leases against the fake driver, simlock stats --since 1h --json reports the counts a test derives independently from simlock events --since 1h", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const first = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(first.code).toBe(0);
    const firstLeaseId = (first.json as { lease: { id: string } }).lease.id;
    // Refused for holding a lease already, refused for want of capacity, and timed out waiting.
    expect((await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"])).code).toBe(13);
    expect(
      (await env.cli([...LEASE_ARGS, "--agent-id", "agent-b", "--no-wait", "--detach"])).code,
    ).toBe(11);
    expect(
      (
        await env.cli([...LEASE_ARGS, "--agent-id", "agent-c", "--timeout", "300ms", "--detach"], {
          timeout: 15_000,
        })
      ).code,
    ).toBe(10);
    expect((await env.cli(["release", firstLeaseId])).code).toBe(0);
    // A second lease on the device the first one left warm.
    const second = await env.cli([...LEASE_ARGS, "--agent-id", "agent-d", "--detach"]);
    expect(second.code).toBe(0);
    expect(
      (await env.cli(["release", (second.json as { lease: { id: string } }).lease.id])).code,
    ).toBe(0);

    const usage = await settledStats(env);
    const everything = await env.events();
    const history = inWindow(everything, usage.window);
    const named = (name: string) => history.filter((event) => event.event === name);

    // The daemon is a minute old, so the history does not reach back an hour: the figures say
    // where they start.
    expect(usage.partial).toBe(true);
    expect(usage.coversFrom).toBe(Math.min(...everything.map((event) => event.timestamp)));
    expect(usage.totals.requests).toBe(named("lease.requested").length);
    expect(usage.totals.granted).toBe(2);
    expect(usage.totals.bySource).toMatchObject(
      countBy(named("lease.granted").map((event) => payload(event).source as string)),
    );
    expect(usage.totals.bySource).toEqual({ booted: 0, provisioned: 1, warm: 1 });
    expect(usage.totals.rejected.total).toBe(named("lease.rejected").length);
    expect(usage.totals.rejected.byReason).toEqual(
      countBy(named("lease.rejected").map((event) => payload(event).reason as string)),
    );
    expect(Object.keys(usage.totals.rejected.byReason).sort()).toEqual([
      "already-leased",
      "no-wait",
      "timeout",
    ]);
    // Held and turnaround are the two leases' own spans, as the events state them.
    const heldByHand = named("lease.granted")
      .map((granted) => {
        const end = named("lease.released").find(
          (event) => payload(event).leaseId === payload(granted).leaseId,
        );
        return (end?.timestamp ?? NaN) - granted.timestamp;
      })
      .sort((a, b) => a - b);
    expect(usage.totals.held.count).toBe(2);
    expect(usage.totals.held.max).toBe(heldByHand[1]);
    expect(usage.totals.turnaround.count).toBe(2);
    expect(usage.totals.wait.count).toBeGreaterThanOrEqual(3);
    expect(usage.totals.provisioning.count).toBe(named("device.provisioned").length);
    expect(usage.totals.boot.count).toBe(named("device.ready").length);
    expect(usage.totals.incidents).toEqual({
      crashRecovered: 0,
      lost: 0,
      quarantineRecovered: 0,
      quarantined: 0,
    });
    expect(usage.workers).toHaveLength(1);
    expect(usage.requesters.map((requester) => requester.id).sort()).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
      "agent-d",
    ]);

    const table = await env.cli(["stats", "--since", "1h"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("Totals");
    expect(table.stdout).toContain("Requests:");
  });

  it("simlock stats --since 1h returns the same figures before and after simlock daemon stop and simlock daemon start", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const lease = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(
      (await env.cli(["release", (lease.json as { lease: { id: string } }).lease.id])).code,
    ).toBe(0);
    const before = await settledStats(env);
    expect(before.totals.granted).toBe(1);

    await env.restartDaemon();
    const after = await settledStats(env);

    expect(after.totals).toMatchObject({
      boot: before.totals.boot,
      bySource: before.totals.bySource,
      granted: before.totals.granted,
      held: before.totals.held,
      incidents: before.totals.incidents,
      provisioning: before.totals.provisioning,
      rejected: before.totals.rejected,
      requests: before.totals.requests,
      turnaround: before.totals.turnaround,
      wait: before.totals.wait,
    });
    expect(after.requesters).toEqual(before.requesters);
  });

  it("on a gateway with two workers, simlock stats has fleet totals and one row per worker, and each worker's own simlock stats covers itself only", async () => {
    const port = await freeLoopbackPort();
    const gateway = await withDaemon({
      configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    const { secret } = minted.json as { secret: string };
    const oneAtATime = { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } };
    const joinWith = (label: string) =>
      withDaemon({
        configOverrides: {
          ...oneAtATime,
          gateway: { label, token: secret, url: `ws://127.0.0.1:${port}` },
        },
        driverScript: { ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] } },
      });
    const workerA = await joinWith("worker-a");
    const workerB = await joinWith("worker-b");
    await waitFor(
      async () => {
        const list = await gateway.cli(["worker", "list", "--json"]);
        const workers = (list.json as { workers: { connection: string }[] }).workers;
        return workers.length === 2 && workers.every((worker) => worker.connection === "connected");
      },
      { label: "both workers joined", timeout: 30_000 },
    );

    // One worker is full after its lease, so the second lease lands on the other.
    for (const agent of ["agent-1", "agent-2"]) {
      const leased = await gateway.cli([...LEASE_ARGS, "--agent-id", agent, "--detach"], {
        timeout: 60_000,
      });
      expect(leased.code).toBe(0);
    }

    let fleet: Usage | undefined;
    fleet = await settledStats(
      gateway,
      (usage) => usage.totals.granted === 2 && usage.workers.length === 2,
    );
    expect(fleet?.totals.requests).toBe(2);
    expect(fleet?.workers.map((worker) => worker.label).sort()).toEqual(["worker-a", "worker-b"]);
    expect(fleet?.workers.map((worker) => worker.granted)).toEqual([1, 1]);

    for (const worker of [workerA, workerB]) {
      const own = await settledStats(worker);
      expect(own.workers).toHaveLength(1);
      expect(own.totals.granted).toBe(1);
      expect(own.workers[0]?.granted).toBe(1);
    }
  });
});
