import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { RecordedEvent } from "./helpers/events.js";

const LEASE_ARGS = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;
const DAY = 24 * 3_600_000;

interface Figures {
  readonly requests: number;
  readonly granted: number;
  readonly bySource: Record<string, number>;
  readonly probes?: number;
  readonly rejected: { readonly total: number; readonly byReason: Record<string, number> };
  readonly wait: { readonly count: number };
  readonly held: { readonly count: number };
  readonly turnaround: { readonly count: number };
  readonly provisioning: { readonly count: number };
  readonly boot: { readonly count: number };
}

interface Usage {
  readonly window: { readonly from: number; readonly to: number };
  readonly totals: Figures;
  readonly workers: readonly (Figures & { readonly id: string; readonly label?: string })[];
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

const payload = (event: RecordedEvent) => event.payload as Record<string, string>;

describe("simlock stats", () => {
  it("after a scripted run against the fake driver with waits, a --no-wait refusal and a timeout, simlock stats --from <before the run> --to <after it, before the stop> --json reports the counts the test derives from simlock events, and prints the same stdout, byte for byte, after simlock daemon stop and simlock daemon start", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const from = new Date(Date.now() - 2_000).toISOString();
    const first = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(first.code).toBe(0);
    const firstLeaseId = (first.json as { lease: { id: string } }).lease.id;
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
    const second = await env.cli([...LEASE_ARGS, "--agent-id", "agent-d", "--detach"]);
    expect(second.code).toBe(0);
    expect(
      (await env.cli(["release", (second.json as { lease: { id: string } }).lease.id])).code,
    ).toBe(0);
    const to = new Date().toISOString();

    const asked = ["stats", "--from", from, "--to", to];
    const result = await env.cli([...asked, "--json"]);
    expect(result.code).toBe(0);
    const usage = result.json as Usage;
    const history = (await env.events()).filter(
      (event) => event.timestamp >= usage.window.from && event.timestamp < usage.window.to,
    );
    const named = (name: string) => history.filter((event) => event.event === name);

    expect(usage.totals.requests).toBe(named("lease.requested").length);
    expect(usage.totals.granted).toBe(named("lease.granted").length);
    expect(usage.totals.bySource).toMatchObject(
      countBy(named("lease.granted").map((event) => payload(event).source as string)),
    );
    expect(usage.totals.rejected.total).toBe(named("lease.rejected").length);
    expect(usage.totals.rejected.byReason).toEqual(
      countBy(named("lease.rejected").map((event) => payload(event).reason as string)),
    );
    expect(Object.keys(usage.totals.rejected.byReason).sort()).toEqual([
      "already-leased",
      "no-wait",
      "timeout",
    ]);
    expect(usage.totals.held.count).toBe(named("lease.released").length);
    expect(usage.totals.provisioning.count).toBe(named("device.provisioned").length);
    // why: a boot of 0 ms is the registry marking a device ready, not a boot: the history keeps no fact of it.
    expect(usage.totals.boot.count).toBe(
      named("device.ready").filter((event) => Number(payload(event).bootDuration) > 0).length,
    );
    expect(usage.totals.wait.count).toBeGreaterThanOrEqual(3);

    await env.restartDaemon();
    const again = await env.cli([...asked, "--json"]);

    expect(again.code).toBe(0);
    expect(again.stdout).toBe(result.stdout);
  }, 240_000);

  it("simlock stats words a window longer than 90 days as BAD_REQUEST with exit 2, a window that ends before the oldest row as HISTORY_NOT_KEPT with exit 12, and a time with no zone as a usage error", async () => {
    const env = await withDaemon();
    const longer = await env.cli(["stats", "--since", "91d"]);
    const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    const early = await env.cli(["stats", "--from", ago(100), "--to", ago(95)]);
    const zoneless = await env.cli(["stats", "--from", "2026-10-15"]);

    expect(longer.code).toBe(2);
    expect(longer.stderr).toContain('"code":"BAD_REQUEST"');
    expect(longer.stderr).toContain("the window must not be longer than 90 days");
    expect(early.code).toBe(12);
    expect(early.stderr).toContain('"code":"HISTORY_NOT_KEPT"');
    expect(early.stderr).toContain("The history does not reach back to the end of that window");
    expect(zoneless.code).toBe(2);
    expect(zoneless.stderr).toContain(
      "Invalid time: 2026-10-15 (use ISO 8601 with Z or an offset)",
    );
  });

  it("on a gateway with two workers, simlock stats --json has fleet totals and one entry per worker, and each worker's own covers itself only", async () => {
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
    const from = new Date(Date.now() - 2_000).toISOString();
    for (const agent of ["agent-1", "agent-2"]) {
      const leased = await gateway.cli([...LEASE_ARGS, "--agent-id", agent, "--detach"], {
        timeout: 60_000,
      });
      expect(leased.code).toBe(0);
    }
    const to = new Date().toISOString();

    const fleet = (await gateway.cli(["stats", "--from", from, "--to", to, "--json"]))
      .json as Usage;

    expect(fleet.totals).toMatchObject({ granted: 2, requests: 2 });
    expect(fleet.totals).not.toHaveProperty("probes");
    expect(fleet.workers.map((worker) => worker.label).sort()).toEqual(["worker-a", "worker-b"]);
    expect(fleet.workers.map((worker) => worker.granted)).toEqual([1, 1]);
    for (const worker of [workerA, workerB]) {
      const own = (await worker.cli(["stats", "--from", from, "--to", to, "--json"])).json as Usage;
      expect(own.workers).toHaveLength(1);
      expect(own.totals.granted).toBe(1);
      expect(own.totals.requests).toBe(0);
      expect(own.totals.probes).toBeGreaterThanOrEqual(1);
    }
  }, 240_000);

  it("simlock stats --csv --from <before the run> --to <after it> after a scripted run with an already-leased refusal has one data row per lease.requested in that window of simlock events, plus one for the refusal", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const from = new Date(Date.now() - 2_000).toISOString();
    const first = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(first.code).toBe(0);
    expect((await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"])).code).toBe(13);
    expect(
      (await env.cli(["release", (first.json as { lease: { id: string } }).lease.id])).code,
    ).toBe(0);
    const to = new Date().toISOString();

    const csv = await env.cli(["stats", "--csv", "--from", from, "--to", to]);

    expect(csv.code).toBe(0);
    const lines = csv.stdout.split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe(
      "requestId,requester,label,platform,model,workerId,source,requestedAt,grantedAt,rejectedAt,endedAt,waitMs,heldMs,turnaroundMs,outcome,probe,reason,endReason",
    );
    const requested = (await env.events()).filter(
      (event) =>
        event.event === "lease.requested" &&
        event.timestamp >= Date.parse(from) &&
        event.timestamp < Date.parse(to),
    );
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(lines.slice(1, -1)).toHaveLength(requested.length + 1);
    expect(lines.filter((line) => line.includes(",already-leased,"))).toHaveLength(1);
  }, 240_000);
});
