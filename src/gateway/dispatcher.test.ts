import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { OPERATIONS, type OperationName } from "../contract/index.js";
import type { DispatchSession } from "../daemon/dispatch.js";
import { FakeClock } from "../ports/index.js";
import { GatewayDispatcher, type GatewayTokenStore } from "./dispatcher.js";
import { MemoryDrainStore } from "./drain-store.js";
import { deviceFixture, leaseFixture, statusFixture } from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

const gatewayConfig = {
  capacity: { strategy: "fixed" as const, config: { maxRunning: 4 } },
  diskPressure: { freeBytesThreshold: 1 },
  downloads: { acceptAndroidLicenses: false, policy: "on-request" as const, timeoutMs: 1 },
  eventBuffer: { capacity: 100 },
  gateway: { disconnectedRetentionMs: 24 * 60 * 60_000, execTimeoutMs: 11 * 60_000 },
  health: {
    enabled: false,
    maxConcurrentRecoveries: 1,
    maxRecoveryAttempts: 1,
    probeIntervalMs: 1,
    recoveryBackoffMs: 1,
    stableObservations: 1,
  },
  http: { enabled: true, host: "127.0.0.1", port: 4700 },
  idle: { deleteAfterMs: 1, shutdownAfterMs: 1 },
  ios: { slim: { bootTimeoutMs: 1, enabled: false } },
  lease: { defaultTtlMs: 900_000, maxTtlMs: 3_600_000 },
  log: { level: "info" as const, rotateBytes: 1 },
  mode: "gateway" as const,
  stalledTransition: { minimumThresholdMs: 1, thresholdMultiplier: 1 },
  warmPool: {
    quarantine: {
      maxRetries: 1,
      maxRetryBackoffMs: 1,
      retryBackoffMs: 1,
      retryBackoffMultiplier: 1,
    },
  },
};

class FakeTokens implements GatewayTokenStore {
  readonly created: string[] = [];
  readonly revoked: string[] = [];

  async create(role: "agent" | "operator" | "worker", label?: string) {
    this.created.push(role);
    return {
      record: { createdAt: 1, id: "tok_1", role, ...(label === undefined ? {} : { label }) },
      secret: "slk_secret",
    };
  }

  async list() {
    return [{ createdAt: 1, id: "tok_1", role: "worker" as const }];
  }

  async revoke(id: string) {
    this.revoked.push(id);
    return true;
  }
}

function harness() {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const workers = new WorkerRegistry({
    clock,
    drainStore: new MemoryDrainStore(),
    eventBus,
    retentionMs: 24 * 60 * 60_000,
  });
  const tokens = new FakeTokens();
  const dispatcher = new GatewayDispatcher({
    awaitReady: async () => {},
    config: gatewayConfig,
    eventBus,
    health: () => "running",
    tokens,
    workers,
  });
  return { clock, dispatcher, eventBus, tokens, workers };
}

function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => "sub_1",
    principal: "operator-1",
    role: "admin",
    ...overrides,
  };
}

/** Every operation the contract declares, minus `daemon.stop` (the transport answers it). */
const EVERY_OPERATION = (Object.keys(OPERATIONS) as OperationName[]).filter(
  (name) => name !== "daemon.stop",
);

describe("GatewayDispatcher", () => {
  it("answers status.get from the fleet", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", {
      capacity: statusFixture().capacity,
      devices: [deviceFixture("dev_1", "leased")],
      health: "running",
      leases: [leaseFixture("lease_1", "dev_1")],
      queueDepth: 0,
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.daemon.mode).toBe("gateway");
    expect(status.workers).toHaveLength(1);
    expect(status.devices).toEqual([expect.objectContaining({ workerId: "wrk_1" })]);
    expect(status.leases).toEqual([expect.objectContaining({ workerId: "wrk_1" })]);
  });

  it("answers catalog.get as the union of the fleet's catalogs", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", {
      catalog: [{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }],
    });

    const catalog = await dispatcher.dispatch("catalog.get", {}, session());

    expect(catalog.platforms[0]?.modelWorkers).toEqual({ "iPhone 17": ["wrk_1"] });
  });

  it("answers config.get with the gateway's own config", async () => {
    const { dispatcher } = harness();

    await expect(dispatcher.dispatch("config.get", {}, session())).resolves.toMatchObject({
      mode: "gateway",
    });
  });

  it("lists workers, and drains, undrains and removes one", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");

    await expect(dispatcher.dispatch("worker.list", {}, session())).resolves.toMatchObject({
      workers: [{ connection: "connected", id: "wrk_1", label: "mac-mini-1" }],
    });

    await expect(
      dispatcher.dispatch("worker.drain", { workerId: "wrk_1" }, session()),
    ).resolves.toEqual({ drained: true, workerId: "wrk_1" });
    expect(workers.view("wrk_1")?.drained).toBe(true);

    await expect(
      dispatcher.dispatch("worker.undrain", { workerId: "wrk_1" }, session()),
    ).resolves.toEqual({ drained: false, workerId: "wrk_1" });

    workers.disconnected("wrk_1");
    await expect(
      dispatcher.dispatch("worker.remove", { workerId: "wrk_1" }, session()),
    ).resolves.toEqual({ removed: true, workerId: "wrk_1" });
  });

  it("refuses to remove a connected worker with WORKER_CONNECTED, naming it", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);

    await expect(
      dispatcher.dispatch("worker.remove", { workerId: "wrk_1" }, session()),
    ).rejects.toMatchObject({ code: "WORKER_CONNECTED", details: { workerId: "wrk_1" } });
  });

  it("reports removed: false for a worker it has never heard of", async () => {
    const { dispatcher } = harness();

    await expect(
      dispatcher.dispatch("worker.remove", { workerId: "wrk_ghost" }, session()),
    ).resolves.toEqual({ removed: false, workerId: "wrk_ghost" });
  });

  it("answers UNKNOWN_WORKER when asked to drain a worker it has no view of", async () => {
    const { dispatcher } = harness();

    await expect(
      dispatcher.dispatch("worker.drain", { workerId: "wrk_ghost" }, session()),
    ).rejects.toMatchObject({ code: "UNKNOWN_WORKER", details: { workerId: "wrk_ghost" } });
  });

  it("keeps worker.* admin-only", async () => {
    const { dispatcher } = harness();

    await expect(
      dispatcher.dispatch("worker.list", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists the fleet's leases and devices, each naming its worker", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", {
      devices: [deviceFixture("dev_1", "leased")],
      leases: [leaseFixture("lease_1", "dev_1")],
    });

    await expect(dispatcher.dispatch("lease.list", {}, session())).resolves.toEqual({
      leases: [expect.objectContaining({ id: "lease_1", workerId: "wrk_1" })],
    });
    await expect(dispatcher.dispatch("list.get", { kind: "devices" }, session())).resolves.toEqual([
      expect.objectContaining({ id: "dev_1", workerId: "wrk_1" }),
    ]);
    // Cleanup rules are a machine's own configuration, and a gateway runs no reaper.
    await expect(dispatcher.dispatch("list.get", { kind: "rules" }, session())).resolves.toEqual(
      [],
    );
  });

  it("filters lease.list by owner for a non-admin session", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    // The worker's lease is owned by a principal on that machine, so an agent on the gateway
    // holds none of it -- which is the honest answer until #118 issues fleet leases.
    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "someone", role: "agent" })),
    ).resolves.toEqual({ leases: [] });
  });

  it("replays and subscribes to its own bus, which carries the fleet's events", async () => {
    const { dispatcher, eventBus } = harness();
    eventBus.emit("lease.granted", { deviceId: "dev_1", leaseId: "l1", requester: "a" }, "worker");

    await expect(dispatcher.dispatch("events.replay", {}, session())).resolves.toEqual([
      expect.objectContaining({ event: "lease.granted" }),
    ]);
    await expect(dispatcher.dispatch("events.subscribe", {}, session())).resolves.toEqual({
      subscribed: true,
      subscriptionId: "sub_1",
    });
  });

  it("mints and revokes its own tokens, worker join tokens included", async () => {
    const { dispatcher, tokens } = harness();

    await expect(
      dispatcher.dispatch("token.create", { role: "worker", label: "mac-mini-1" }, session()),
    ).resolves.toMatchObject({ secret: "slk_secret", token: { role: "worker" } });
    expect(tokens.created).toEqual(["worker"]);

    await expect(dispatcher.dispatch("token.revoke", { id: "tok_1" }, session())).resolves.toEqual({
      revoked: true,
    });
  });

  describe("UNSUPPORTED_IN_GATEWAY_MODE", () => {
    it.each(["nuke.run", "cleanup.run", "doctor.run", "driver.passthrough"] as const)(
      "%s stays per-worker, permanently",
      async (operation) => {
        const { dispatcher } = harness();
        const input =
          operation === "driver.passthrough" ? { args: ["devices"], tool: "adb" } : { fix: true };

        await expect(dispatcher.dispatch(operation, input, session())).rejects.toMatchObject({
          code: "UNSUPPORTED_IN_GATEWAY_MODE",
          details: { operation },
        });
      },
    );

    it.each([
      ["lease.request", { model: "iPhone 17", platform: "ios" }],
      ["lease.renew", { leaseId: "lease_1" }],
      ["lease.release", { leaseId: "lease_1" }],
      ["lease.cancel", {}],
      ["lease.release-all", {}],
    ] as const)("%s waits for fleet routing", async (operation, input) => {
      const { dispatcher } = harness();

      await expect(
        dispatcher.dispatch(operation as OperationName, input, session()),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_IN_GATEWAY_MODE", details: { operation } });
    });
  });

  it("has an answer for every operation the contract declares", async () => {
    // Not one operation may fall through to `UNKNOWN_REQUEST` on a gateway: the contract is the
    // same one every frontend renders, so "the gateway forgot about this operation" must be a
    // failing test rather than a runtime surprise. Inputs here are only shaped well enough to
    // reach the handler.
    const inputs: Partial<Record<OperationName, unknown>> = {
      "driver.passthrough": { args: [], tool: "adb" },
      "lease.release": { leaseId: "lease_1" },
      "lease.renew": { leaseId: "lease_1" },
      "lease.request": { model: "iPhone 17", platform: "ios" },
      "token.create": { role: "agent" },
      "token.revoke": { id: "tok_1" },
      "worker.drain": { workerId: "wrk_1" },
      "worker.remove": { workerId: "wrk_1" },
      "worker.undrain": { workerId: "wrk_1" },
    };
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.disconnected("wrk_1");

    for (const operation of EVERY_OPERATION) {
      const outcome = await dispatcher.dispatch(operation, inputs[operation] ?? {}, session()).then(
        () => "answered",
        (error: unknown) => (error as { code?: string }).code ?? "threw",
      );
      expect({ operation, outcome }).not.toEqual({ operation, outcome: "UNKNOWN_REQUEST" });
    }
  });
});
