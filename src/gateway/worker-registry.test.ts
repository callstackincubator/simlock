import { describe, expect, it } from "vitest";
import { type EventEnvelope } from "../bus/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { type Logger } from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { catalogFixture, hostFixture, leaseFixture } from "./test-support.js";
import { RETENTION_MS, GATEWAY_REQUESTER_PREFIX, registry } from "./test-worker-registry.js";

/** Records every `warn` call, the same shape `service.test.ts`'s own `RecordingLogger` uses --
 * §15's warning is asserted on directly rather than only on the view it leaves behind. */
class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(): void {}
  info(): void {}
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(fields === undefined ? { message } : { fields, message });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** A gateway-issued lease's `requesterId` (ADR 0005 §14/§27): the fixed prefix `pruneExpired`
 * scopes its retention hold to, so a fixture built with it exercises the real branch rather than
 * one that happens to pass because no scoping exists yet. */
function gatewayLeaseFixture(id: string, deviceId: string) {
  return { ...leaseFixture(id, deviceId), requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1` };
}

function names(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.event);
}

describe("WorkerRegistry", () => {
  it("builds a view on connect, with nothing a worker reports until it reports it, and emits the fact", () => {
    const { events, workers } = registry();

    const view = workers.connected("wrk_1", "mac-mini-1", "0.3.0");

    expect(view).toEqual({
      connection: "connected",
      drained: false,
      id: "wrk_1",
      label: "mac-mini-1",
      lastSeenAt: 1_000,
      version: "0.3.0",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "worker.connected",
      payload: { label: "mac-mini-1", version: "0.3.0", workerId: "wrk_1" },
    });
  });

  it("refreshes what a worker reports and leaves the rest alone", () => {
    const { clock, workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");

    clock.advance(5_000);
    workers.refresh("wrk_1", { health: "running", queueDepth: 2, leases: [] });

    expect(workers.view("wrk_1")).toMatchObject({
      connection: "connected",
      health: "running",
      lastSeenAt: 6_000,
      queueDepth: 2,
    });
  });

  it("keeps an absent key's previous value, so an event-driven refresh does not blank the catalog", () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", {
      catalog: [
        {
          modelAliases: {},
          classDefaults: {},
          modelClasses: {},
          modelRuntimes: { "iPhone 17": ["26.0"] },
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
        },
      ],
    });

    workers.refresh("wrk_1", { queueDepth: 1 });

    expect(workers.view("wrk_1")?.catalog).toEqual([
      {
        modelAliases: {},
        classDefaults: {},
        modelClasses: {},
        modelRuntimes: { "iPhone 17": ["26.0"] },
        models: ["iPhone 17"],
        platform: "ios",
        runtimes: ["26.0"],
      },
    ]);
  });

  it("drops a refresh for a view that has been removed", async () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.disconnected("wrk_1");
    await workers.remove("wrk_1");

    workers.refresh("wrk_1", { queueDepth: 9 });

    expect(workers.view("wrk_1")).toBeUndefined();
  });

  it("lists each worker's granted devices under that worker's id, and keeps them through a refresh that carries none", () => {
    const { workers } = registry();
    const granted = (udid: string) => ({
      physical: false,
      driverDeviceId: udid,
      id: "dev_1",
      mode: "full" as const,
      spec: { physical: false, model: "iPhone 17", osVersion: "26.0", platform: "ios" as const },
    });
    workers.connected("wrk_a", undefined, "0.3.0");
    workers.connected("wrk_b", undefined, "0.3.0");
    workers.refresh("wrk_a", { grantedDevices: [granted("UDID-A")] });
    workers.refresh("wrk_b", { grantedDevices: [granted("UDID-B")] });
    workers.refresh("wrk_b", { queueDepth: 1 });

    expect(
      workers
        .grantedDevices()
        .map(({ driverDeviceId, workerId }) => ({ driverDeviceId, workerId })),
    ).toEqual([
      { driverDeviceId: "UDID-A", workerId: "wrk_a" },
      { driverDeviceId: "UDID-B", workerId: "wrk_b" },
    ]);
  });

  it("forgets a worker's granted devices with its view, so a worker re-added under that id lists none of them", async () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", {
      grantedDevices: [
        {
          physical: false,
          driverDeviceId: "UDID-1",
          id: "dev_1",
          mode: "full",
          spec: { physical: false, model: "iPhone 17", osVersion: "26.0", platform: "ios" },
        },
      ],
    });
    expect(workers.grantedDevices().map(({ id, workerId }) => ({ id, workerId }))).toEqual([
      { id: "dev_1", workerId: "wrk_1" },
    ]);

    workers.disconnected("wrk_1");
    await workers.remove("wrk_1");
    workers.connected("wrk_1", undefined, "0.3.0");

    expect(workers.grantedDevices()).toEqual([]);
  });

  describe("when the catalog was read (ADR 0009 §4)", () => {
    const catalog = catalogFixture([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]).platforms;

    it("records the time of a refresh that carries a catalog, and not of one that carries none", () => {
      const { clock, workers } = registry();
      workers.connected("wrk_a", undefined, undefined);
      expect(workers.view("wrk_a")?.catalogReadAt).toBeUndefined();

      clock.advance(5);
      workers.refresh("wrk_a", { devices: [] });
      expect(workers.view("wrk_a")?.catalogReadAt).toBeUndefined();

      clock.advance(5);
      workers.refresh("wrk_a", { catalog });
      expect(workers.view("wrk_a")?.catalogReadAt).toBe(clock.now());

      const readAt = clock.now();
      clock.advance(5);
      workers.refresh("wrk_a", { devices: [] });
      expect(workers.view("wrk_a")?.catalogReadAt).toBe(readAt);
    });

    it("clears it when the worker connects again, and keeps the catalog it last read", () => {
      const { workers } = registry();
      workers.connected("wrk_a", undefined, undefined);
      workers.refresh("wrk_a", { catalog });

      workers.disconnected("wrk_a");
      expect(workers.view("wrk_a")?.catalogReadAt).toBeDefined();

      workers.connected("wrk_a", undefined, undefined);
      expect(workers.view("wrk_a")?.catalogReadAt).toBeUndefined();
      expect(workers.view("wrk_a")?.catalog).toEqual(catalog);
    });

    it("tells a catalog that was read and is empty from one that has not arrived", () => {
      const { workers } = registry();
      workers.connected("wrk_empty", undefined, undefined);
      workers.connected("wrk_never", undefined, undefined);

      workers.refresh("wrk_empty", { catalog: [] });
      workers.refresh("wrk_never", { devices: [] });

      expect(workers.view("wrk_empty")?.catalogReadAt).toBeDefined();
      expect(workers.view("wrk_never")?.catalogReadAt).toBeUndefined();
    });
  });

  describe("warning on a worker's lower lease.maxTtlMs (ADR 0005 §15)", () => {
    it("warns once a worker's own cap is refreshed in below the gateway's", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", "mac-mini-1", "0.3.0");

      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });

      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]).toMatchObject({
        fields: {
          gatewayMaxTtlMs: 3_600_000,
          label: "mac-mini-1",
          workerId: "wrk_1",
          workerMaxTtlMs: 1_800_000,
        },
      });
    });

    it("does not warn when a worker's own cap is at or above the gateway's", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      // Exactly equal, and then strictly above -- neither is "below".
      workers.refresh("wrk_1", { lease: { maxTtlMs: 3_600_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 7_200_000 } });

      expect(logger.warnings).toEqual([]);
    });

    it("does not warn, and does not crash, when a worker reports no cap at all", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      // No `lease` key on the snapshot: exactly what an event-driven refresh sends today
      // (`config.get` is only read alongside the catalog), and what an incompatible or
      // config.get-failed worker's view carries forever.
      expect(() => workers.refresh("wrk_1", { queueDepth: 1 })).not.toThrow();

      expect(workers.view("wrk_1")?.lease).toBeUndefined();
      expect(logger.warnings).toEqual([]);
    });

    it("does not repeat the warning on a later refresh reporting the same lower cap", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      // The periodic backstop tick re-reads config.get (and so `lease.maxTtlMs`) on every
      // refresh alongside the catalog (`WorkerLink#rebuildView`) -- an unchanged report must
      // not turn into a warning every `refreshIntervalMs`.
      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });

      expect(logger.warnings).toHaveLength(1);
    });

    it("warns again if the cap drops further while already below the gateway's", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 900_000 } });

      expect(logger.warnings).toHaveLength(2);
      expect(logger.warnings[1]?.fields).toMatchObject({ workerMaxTtlMs: 900_000 });
    });
  });

  it("marks a version-mismatched worker incompatible with both ranges, and rejects it", () => {
    const { events, workers } = registry();

    const view = workers.incompatible(
      "wrk_1",
      "old-mac",
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    expect(view).toMatchObject({
      connection: "incompatible",
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      version: "0.2.0",
    });
    // ADR 0005 §31: no event at all. Not `worker.connected`, because nothing usable
    // connected, and not `worker.rejected` either -- that uplink authenticated. The view is
    // the fact.
    expect(events).toEqual([]);
  });

  it("carries no host facts on an incompatible worker's view, even after a compatible session", () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", { host: hostFixture() });
    expect(workers.view("wrk_1")?.host).toEqual(hostFixture());

    // The same machine comes back downgraded: it is never asked for status, so the host facts
    // its earlier session reported are no longer known.
    const view = workers.incompatible(
      "wrk_1",
      undefined,
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    expect(view.host).toBeUndefined();
    expect(workers.view("wrk_1")?.host).toBeUndefined();
  });

  it("clears the protocol ranges when an upgraded worker reconnects", () => {
    const { workers } = registry();
    workers.incompatible(
      "wrk_1",
      undefined,
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    const view = workers.connected("wrk_1", undefined, "0.3.0");

    expect(view.connection).toBe("connected");
    expect(view.protocol).toBeUndefined();
  });

  describe("retention", () => {
    it("forgets a disconnected view once the retention window passes", async () => {
      const { clock, events, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS - 1);
      await workers.pruneExpired();
      expect(workers.view("wrk_1")).toBeDefined();

      clock.advance(1);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        event: "worker.removed",
        payload: { reason: "retention", workerId: "wrk_1" },
      });
    });

    it("forgets a worker that disconnected while starting, when no lease was ever read from it, once the retention window passes", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("never forgets a worker that disconnected while starting, whose last-read gateway-issued leases are still live", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const lease = { ...gatewayLeaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [lease] });
      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });
      workers.disconnected("wrk_1");

      clock.advance(5 * RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeDefined();

      clock.advance(5 * RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("never forgets a worker whose gateway-issued leases are still live, however long it has been gone", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const lease = { ...gatewayLeaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [lease] });
      workers.disconnected("wrk_1");

      clock.advance(5 * RETENTION_MS);
      await workers.pruneExpired();

      // A device is still held on a machine nobody can reach: that is exactly what an operator
      // must be able to see.
      expect(workers.view("wrk_1")).toBeDefined();
    });

    // ADR 0005 §6/§14 (M2): the retention hold is scoped to leases *this gateway* issued. A
    // worker's own local lease -- an agent on that machine, never routed through the gateway --
    // is none of the gateway's business to keep a view alive for.
    // H3: a registry with no `gatewayRequesterPrefix` cannot tell a gateway-issued lease apart
    // from a worker-local one, so per `safety.md`'s fails-closed instinct it must not guess "none
    // of these are mine" and prune anyway. `GatewayService` always supplies the prefix, but the
    // class is exported and `dispatcher.test.ts`'s harness constructs one without it.
    it("holds a view with a live lease when built with no gatewayRequesterPrefix at all", async () => {
      const { clock, workers } = registry({ gatewayRequesterPrefix: null });
      workers.connected("wrk_1", undefined, undefined);
      const lease = { ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [lease] });
      workers.disconnected("wrk_1");

      clock.advance(5 * RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeDefined();
    });

    it("forgets a worker whose only live lease is a local one, not the gateway's own", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const localLease = { ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [localLease] });
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("forgets it once the last lease deadline has passed and retention has elapsed", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", {
        leases: [{ ...gatewayLeaseFixture("lease_1", "dev_1"), ttlDeadline: 2_000 }],
      });
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("leaves a connected view alone no matter how long it has been connected", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      clock.advance(10 * RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeDefined();
    });

    // C1: a regression in the M1 fix above -- `pruneExpired` reused `#forget`, which also
    // cleared the drain flag. Retention is not an operator action (ADR 0005 §9: "only `undrain`
    // ends it"; §8a: the drained set is the gateway's own record, kept separate from the
    // observed view precisely so a drain outlives it). An operator who drains a machine for
    // maintenance and leaves it off over a retention window must find it still drained when it
    // reconnects, exactly like the reconnect and restart cases above -- this crosses drain with
    // retention, which neither of those tests do.
    it("keeps the drain flag when retention forgets the view, unlike an operator remove", async () => {
      const store = new MemoryDrainStore();
      const { clock, workers } = registry({ drainStore: store });
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(workers.connected("wrk_1", undefined, undefined).drained).toBe(true);
    });

    // why: Hardening: the C1 test above is correct that retention must not clear a drain flag -- but
    // once a view is gone, neither `setDrained` nor `undrain` can reach that flag either
    // (`UNKNOWN_WORKER`, no view to require). Before this fix, nothing could ever clear it
    // again: `remove` returned early on a missing view before touching `#drained`, leaving
    // the drain store growing a permanent `true` for a worker that no longer exists -- M1's
    // "unbounded file" relocated, not closed. `remove` on that same id is the one command
    // already documented as a no-op-but-not-an-error for a forgotten worker; it must also be
    // the one that can still clear a flag stranded behind it.
    it("lets remove() clear a drain flag stranded by retention, with no view to answer removed: true", async () => {
      const store = new MemoryDrainStore();
      const { clock, workers } = registry({ drainStore: store });
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired();
      expect(workers.view("wrk_1")).toBeUndefined();

      // No view left to remove, so this is still "already forgotten" -- but the flag itself
      // must actually clear, and the store must actually persist that.
      await expect(workers.remove("wrk_1")).resolves.toBe(false);
      await expect(store.load()).resolves.not.toContain("wrk_1");

      // The real proof: a later reconnect under the same id is no longer drained.
      expect(workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
    });
  });

  describe("drain", () => {
    it("flags the view and emits the fact, once", async () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", "mac-mini-1", undefined);

      const view = await workers.setDrained("wrk_1", true);
      expect(view.drained).toBe(true);
      expect(events.at(-1)).toMatchObject({
        event: "worker.drain-started",
        payload: { label: "mac-mini-1", workerId: "wrk_1" },
      });

      // Idempotent: draining again is not an error and is not a second fact.
      const before = events.length;
      await workers.setDrained("wrk_1", true);
      expect(events).toHaveLength(before);
    });

    it("undrains", async () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);

      await workers.setDrained("wrk_1", false);

      expect(workers.view("wrk_1")?.drained).toBe(false);
      expect(names(events)).toContain("worker.drain-ended");
    });

    it("refuses an id it has no view of", async () => {
      const { workers } = registry();

      await expect(workers.setDrained("wrk_missing", true)).rejects.toMatchObject({
        code: "UNKNOWN_WORKER",
      });
    });

    it("survives a reconnect", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");

      expect(workers.connected("wrk_1", undefined, undefined).drained).toBe(true);
    });

    it("survives a gateway restart, which is the point of persisting it", async () => {
      const store = new MemoryDrainStore();
      const first = registry({ drainStore: store });
      first.workers.connected("wrk_1", undefined, undefined);
      await first.workers.setDrained("wrk_1", true);

      // A second gateway, with nothing in memory and the same file.
      const second = registry({ drainStore: store });
      await second.workers.load();

      // The worker has not even connected yet, and is already drained when it does.
      expect(second.workers.connected("wrk_1", undefined, undefined).drained).toBe(true);
    });

    it("stops persisting a worker that has been undrained", async () => {
      const store = new MemoryDrainStore();
      const first = registry({ drainStore: store });
      first.workers.connected("wrk_1", undefined, undefined);
      await first.workers.setDrained("wrk_1", true);
      await first.workers.setDrained("wrk_1", false);

      const second = registry({ drainStore: store });
      await second.workers.load();

      expect(second.workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
    });
  });

  describe("remove", () => {
    it("forgets a disconnected view", async () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", "mac-mini-1", undefined);
      workers.disconnected("wrk_1");

      await expect(workers.remove("wrk_1")).resolves.toBe(true);

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        event: "worker.removed",
        payload: { reason: "operator", workerId: "wrk_1" },
      });
    });

    it("refuses a connected one", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      await expect(workers.remove("wrk_1")).rejects.toMatchObject({ code: "WORKER_CONNECTED" });
      expect(workers.view("wrk_1")).toBeDefined();
    });

    it("refuses an incompatible one too -- its uplink is open", async () => {
      const { workers } = registry();
      workers.incompatible(
        "wrk_1",
        undefined,
        { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
        undefined,
      );

      await expect(workers.remove("wrk_1")).rejects.toMatchObject({ code: "WORKER_CONNECTED" });
    });

    it("reports `false` for an id it has never heard of, rather than failing", async () => {
      const { events, workers } = registry();

      await expect(workers.remove("wrk_missing")).resolves.toBe(false);
      expect(names(events)).not.toContain("worker.removed");
    });

    // why: M1: `#forget` used to delete the view and leave the drain flag standing forever --
    // the drain store grew without bound, and a worker whose id was ever seen again would come
    // back silently drained with no way to `undrain` it (there is no view to undrain).
    it("clears a removed worker's drain flag too, and persists that", async () => {
      const store = new MemoryDrainStore();
      const first = registry({ drainStore: store });
      first.workers.connected("wrk_1", undefined, undefined);
      await first.workers.setDrained("wrk_1", true);
      first.workers.disconnected("wrk_1");

      await expect(first.workers.remove("wrk_1")).resolves.toBe(true);

      // Reconnecting the same id, on the same registry, must not come back drained: the flag
      // was cleared in memory...
      expect(first.workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
      first.workers.disconnected("wrk_1");
      await first.workers.remove("wrk_1");

      // ...and on disk, so a second gateway reading the same store does not resurrect it either.
      const second = registry({ drainStore: store });
      await second.workers.load();
      expect(second.workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
    });

    it("undrain fails UNKNOWN_WORKER for a worker removed while drained -- there is no view left", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");
      await workers.remove("wrk_1");

      await expect(workers.setDrained("wrk_1", false)).rejects.toMatchObject({
        code: "UNKNOWN_WORKER",
      });
    });
  });
});
