import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { OPERATIONS, type OperationName } from "../contract/index.js";
import type { DispatchSession } from "../daemon/dispatch.js";
import { FakeClock } from "../ports/index.js";
import { GatewayDispatcher, type GatewayTokenStore } from "./dispatcher.js";
import { MemoryDrainStore } from "./drain-store.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { createRoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

const gatewayConfig = {
  capacity: { strategy: "fixed" as const, config: { maxRunning: 4 } },
  diskPressure: { freeBytesThreshold: 1 },
  downloads: { acceptAndroidLicenses: false, policy: "on-request" as const, timeoutMs: 1 },
  eventBuffer: { capacity: 100 },
  exec: { timeoutMs: 600_000 },
  gateway: {
    disconnectedRetentionMs: 24 * 60 * 60_000,
    execTimeoutMs: 11 * 60_000,
    leaseRequestTimeoutMs: 5 * 60_000,
    routing: "warm-then-free" as const,
  },
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
    // Only "tok_1" is ever actually minted by this fake -- anything else is the "already gone,
    // or never real" case C-2's test below needs a real `false` for.
    return id === "tok_1";
  }
}

/** Matches `service.test.ts`'s `principal: "gw:instance-1"` -- ADR 0005 §14/§27's own-lease
 * prefix is that principal plus a trailing `:`, the same shape `worker-registry.test.ts` uses. */
const GATEWAY_REQUESTER_PREFIX = "gw:instance-1:";

/** A `WorkerDirectory` a test populates by hand -- see `fleet-coordinator.test.ts`'s own copy
 * for the fuller doc comment; this file only ever needs one worker at a time. */
class FakeDirectory implements WorkerDirectory {
  readonly clients = new Map<string, ScriptedWorkerClient>();

  add(workerId: string, client: ScriptedWorkerClient): void {
    this.clients.set(workerId, client);
  }

  target(workerId: string): WorkerDispatchTarget | undefined {
    const client = this.clients.get(workerId);
    if (client === undefined) return undefined;
    return { client: () => client.asClient(), reachable: true, refresh: async () => {}, workerId };
  }
}

function harness() {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const workers = new WorkerRegistry({
    clock,
    drainStore: new MemoryDrainStore(),
    eventBus,
    leaseMaxTtlMs: gatewayConfig.lease.maxTtlMs,
    retentionMs: 24 * 60 * 60_000,
  });
  const tokens = new FakeTokens();
  /** C-2: every id `closeUplinksForToken` was actually called with, in call order. */
  const closedUplinkTokens: string[] = [];
  const directory = new FakeDirectory();
  const leaseIndex = new FleetLeaseIndex(GATEWAY_REQUESTER_PREFIX);
  const coordinator = new FleetLeaseCoordinator({
    clock,
    directory,
    eventBus,
    execTimeoutMs: gatewayConfig.gateway.execTimeoutMs,
    leaseRequestTimeoutMs: gatewayConfig.gateway.leaseRequestTimeoutMs,
    idGenerator: {
      generate: (() => {
        let next = 1;
        return () => `${next++}`;
      })(),
    },
    leaseIndex,
    routing: createRoutingPolicy("warm-then-free"),
    views: workers,
  });
  const dispatcher = new GatewayDispatcher({
    awaitReady: async () => {},
    closeUplinksForToken: async (tokenId) => {
      closedUplinkTokens.push(tokenId);
    },
    config: gatewayConfig,
    coordinator,
    eventBus,
    health: () => "running",
    leaseIndex,
    tokens,
    workers,
  });
  return {
    clock,
    closedUplinkTokens,
    coordinator,
    directory,
    dispatcher,
    eventBus,
    leaseIndex,
    tokens,
    workers,
  };
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

  // P-1 (third review round): the previous version of `#leaseList` compared a namespaced form
  // of the session's own principal to each lease's `ownerId` -- a comparison that was false by
  // construction (see `#leaseList`'s own comment) and so, in practice, indistinguishable from
  // simply returning `[]`.
  //
  // Round 6 review: this test's title used to claim a non-admin session sees "no fleet leases at
  // all", which #118 -- this PR -- made false when it replaced the handler with `FleetLeaseIndex`:
  // such a session now does see leases this gateway issued to it, as the third test below proves.
  // What this one actually pins is the baseline the other two build on: a worker's *own local*
  // lease is not a fleet lease and is never a candidate, whoever asks. The title says only that
  // now (testing rule 1).
  it("shows a non-admin session none of a worker's own local leases", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    // The worker's lease is a worker-local one -- never indexed by this gateway (only
    // `rebuildFromWorker`/an actual grant adds an entry) -- so a non-admin session holds none of
    // it, exactly as an unrelated fleet client should.
    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "someone", role: "agent" })),
    ).resolves.toEqual({ leases: [] });
  });

  // #118 replaced the P2 namespace-comparison this test used to pin with the lease index: a
  // non-admin session's `lease.list` now iterates `leaseIndex.all()` rather than scanning every
  // worker's raw leases, so a worker's own local lease is never even a candidate -- it cannot
  // "match" a session by coincidence of principal spelling, because it is never looked up by
  // principal at all. Still worth its own test: this is the case that would tell a correct
  // implementation apart from a naive "compare raw principals" one.
  it("does not let a gateway session's raw principal match a worker's own local lease owner of the same name", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    // `leaseFixture`'s ownerId ("agent-1") is an un-namespaced *local* principal -- exactly what
    // a worker's own agent looks like, and never added to this gateway's lease index.
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "agent-1", role: "agent" })),
    ).resolves.toEqual({ leases: [] });
  });

  // The positive match: a lease this gateway issued, rebuilt purely from a worker's reported
  // view (§30's reconnect path -- see `fleet-coordinator.test.ts` for the admission-path
  // equivalent), is rewritten to its gateway id and fleet-level requester and is visible to the
  // owner that requested it (ADR §27a: `ownerId` is the real principal, round-tripped -- not
  // namespaced, unlike `requesterId`).
  it("sees a gateway-issued lease rebuilt from a worker's view, rewritten to its gateway id", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", undefined);
    const lease = {
      ...leaseFixture("lease_1", "dev_1"),
      ownerId: "agent-1",
      requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
    };
    // `workers.refresh` alone is enough: `FleetLeaseCoordinator` is subscribed to this same
    // registry's `onViewsChanged` and rebuilds its lease index from every view it sees, exactly
    // as it would from a real `WorkerLink`'s refresh -- nothing in this test drives the index by
    // hand.
    workers.refresh("wrk_1", { leases: [lease] });

    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "agent-1", role: "agent" })),
    ).resolves.toEqual({
      leases: [
        expect.objectContaining({
          id: "wrk_1.lease_1",
          requesterId: "agent-1",
          worker: { id: "wrk_1", label: "mac-mini-1" },
        }),
      ],
    });
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

  // C-2, ADR 0005 §8 ("revoking closes the uplink"): `#tokenRevoke` used to only write the
  // store -- the join token was checked once, at upgrade, and nothing ever re-verified a live
  // link, so revoking a worker's token had no observable effect until that worker happened to
  // reconnect on its own, possibly never. This asserts the actual wiring `main.ts` depends on:
  // a successful revoke calls `closeUplinksForToken` with exactly the revoked id.
  it("closes the uplink a revoked token authorized, not merely the store entry (C-2)", async () => {
    const { closedUplinkTokens, dispatcher } = harness();

    await expect(dispatcher.dispatch("token.revoke", { id: "tok_1" }, session())).resolves.toEqual({
      revoked: true,
    });

    expect(closedUplinkTokens).toEqual(["tok_1"]);
  });

  // The other half of the same wiring: revoking an id the store never had is not a live link to
  // close either, and must not call the hook with a token id that authorized nothing.
  it("does not try to close an uplink for a token id that was never real (C-2)", async () => {
    const { closedUplinkTokens, dispatcher } = harness();

    await expect(
      dispatcher.dispatch("token.revoke", { id: "tok_unknown" }, session()),
    ).resolves.toEqual({ revoked: false });

    expect(closedUplinkTokens).toEqual([]);
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
  });

  describe("lease lifecycle and device.exec (#118)", () => {
    it("forwards lease.request through the fleet coordinator and answers UNKNOWN_LEASE for renew/release/exec against an id it never issued", async () => {
      const { dispatcher } = harness();

      // No worker connected at all: a `noWait` request has nowhere to go and is refused
      // immediately, rather than the pre-#118 permanent `UNSUPPORTED_IN_GATEWAY_MODE`. A plain
      // `DispatchError("NO_CAPACITY", ...)` (H9, round 2 review) -- no gateway-specific error
      // class for `daemon/error-code.ts` to import and recognize.
      await expect(
        dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17", noWait: true, platform: "ios" },
          session({ role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "NO_CAPACITY" });

      for (const [operation, input] of [
        ["lease.renew", { leaseId: "wrk_ghost.lease_1" }],
        ["lease.release", { leaseId: "wrk_ghost.lease_1" }],
        ["device.exec", { args: [], leaseId: "wrk_ghost.lease_1", tool: "adb" }],
      ] as const) {
        await expect(
          dispatcher.dispatch(operation, input, session({ role: "agent" })),
        ).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });
      }
    });

    it("answers not-found for lease.cancel and an empty result for lease.release-all with nothing queued or leased", async () => {
      const { dispatcher } = harness();

      await expect(
        dispatcher.dispatch("lease.cancel", {}, session({ role: "agent" })),
      ).resolves.toEqual({ result: "not-found" });
      await expect(dispatcher.dispatch("lease.release-all", {}, session())).resolves.toEqual({
        leaseIds: [],
      });
    });

    // ADR §27a's whole point: the owner a rebuilt lease authorizes against has to be the real
    // principal the worker round-tripped back, not this gateway's own uplink principal -- and it
    // has to work on an index built purely by `rebuildFromWorker` (a reconnect), never through
    // `coordinator.request` in this process. This is the one place a naive "derive ownerId from
    // the connection" implementation and a correct one visibly disagree.
    it("authorizes lease.renew for the original requester and forbids everyone else, on a lease rebuilt after reconnect", async () => {
      const { dispatcher, directory, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", {
        leases: [
          {
            ...leaseFixture("lease_1", "dev_1"),
            ownerId: "alice-principal",
            requesterId: `${GATEWAY_REQUESTER_PREFIX}alice`,
          },
        ],
      });
      const gatewayLeaseId = "wrk_1.lease_1";
      client.renewLeaseQueue.push({
        kind: "ok",
        record: {
          ...leaseFixture("lease_1", "dev_1"),
          ownerId: "alice-principal",
          ttlMs: 1_800_000,
        },
      });

      await expect(
        dispatcher.dispatch(
          "lease.renew",
          { leaseId: gatewayLeaseId },
          session({ principal: "alice-principal", role: "agent" }),
        ),
      ).resolves.toMatchObject({ id: gatewayLeaseId, requesterId: "alice" });

      await expect(
        dispatcher.dispatch(
          "lease.renew",
          { leaseId: gatewayLeaseId },
          session({ principal: "mallory-principal", role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("forwards device.exec to the worker that holds the lease, gated on the caller owning it", async () => {
      const { coordinator, directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const grant = await coordinator.request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: true, ownerId: "agent-1", requesterId: "agent-1" },
      );
      client.execQueue.push({ exitCode: 3, kind: "ok" });

      await expect(
        dispatcher.dispatch(
          "device.exec",
          { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
          session({ principal: "agent-1", role: "agent" }),
        ),
      ).resolves.toEqual({ exitCode: 3 });

      await expect(
        dispatcher.dispatch(
          "device.exec",
          { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
          session({ principal: "someone-else", role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // C3 (round 3 review): exercises the gateway's *real* dispatcher end to end
    // (`GatewayDispatcher` -> `FleetLeaseCoordinator#exec` -> a scripted worker), unlike
    // `http/app.test.ts`'s own "opens the stream when the process starts" test, which drives
    // `call.session.onStarted?.()` by hand and so cannot notice a dispatcher that stops calling
    // it for a genuinely silent, long-running command.
    it("calls onStarted for a silent device.exec from the worker's own started push, with no output and no answer (ADR §19a/§19b/§19e)", async () => {
      const { coordinator, directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const grant = await coordinator.request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: true, ownerId: "agent-1", requesterId: "agent-1" },
      );
      // §19b's own worked example: `simctl install <path>` never writes anything while it runs,
      // and the worker here never answers at all -- but it does say the process exists, which is
      // the fact a transport needs to commit its 200. No clock is advanced below: this asserts
      // the relay, not a timer.
      client.execQueue.push({ kind: "hang", started: true });

      let started = false;
      void dispatcher.dispatch(
        "device.exec",
        { args: ["install", "/path/to.app"], leaseId: grant.lease.id, tool: "simctl" },
        session({
          onStarted: () => {
            started = true;
          },
          principal: "agent-1",
          role: "agent",
        }),
      );
      await Promise.resolve();

      expect(started).toBe(true);
    });

    it("lease.request: rejects a non-admin session naming owner with FORBIDDEN, never silently ignoring it (ADR §27a, H7)", async () => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      // Round 6 review: this harness used to connect `wrk_1` to the registry without adding a
      // client for it, so removing the gate under test made the request route to an unreachable
      // target, get re-queued by `#staleView`, and fail the test by *timing out* -- an outcome a
      // gateway with no gate at all produces just as well. Its H3 sibling below already had the
      // fix and said why; this one had been left behind. A worker able and willing to grant,
      // plus `noWait`, means an ungated `owner` is caught by the lease actually being issued
      // (testing rule 2: fail on a named assertion, not a schedule).
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      await expect(
        dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17", noWait: true, owner: "someone-else", platform: "ios" },
          session({ principal: "agent-1", role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // H3 (round 3 review): §27a's gate here used to be `role !== "admin"`, admitting any HTTP
    // `operator` bearer token connected directly to this gateway -- the same over-wide check
    // `daemon/dispatcher.ts`'s own `#leaseRequest` shared. `isGatewayUplink` is narrower: it is
    // stamped only on a *worker's* connection to its own configured gateway
    // (`DaemonServer#acceptUplink`), and nothing forwards into a gateway's own front door the
    // way a gateway forwards into a worker -- there is no "gateway of gateways" in ADR 0005. So
    // no session this handler is ever called with can carry it, and `owner` is unconditionally
    // `FORBIDDEN` here now, admin included: this test pins that a plain admin session (still
    // `role: "admin"`, still what an operator token maps to) is refused exactly like an agent's.
    it("lease.request: rejects a plain admin session (not the gateway's uplink) naming owner with FORBIDDEN -- no session ever reaching this handler is (ADR §27a, H3)", async () => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      // A worker able and willing to grant it -- so a gate that let this session's `owner`
      // through would be caught by the lease actually being issued, not by an unrelated
      // `NO_CAPACITY`/timeout that would pass just as well with no gate at all.
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      await expect(
        dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17", noWait: true, owner: "agent-7", platform: "ios" },
          session({ principal: "operator-1", role: "admin" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("lease.request: forwards owner as `ownerId` end to end when the session is the gateway's own uplink (ADR §27a, H3) -- exercising the same field the worker's own dispatcher gates, on this dispatcher's shared handler shape", async () => {
      const { directory, dispatcher, leaseIndex, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17", noWait: true, owner: "agent-7", platform: "ios" },
        session({ isGatewayUplink: true, principal: "gw:instance-1", role: "admin" }),
      );

      const gatewayLeaseId = (grant as { lease: { id: string } }).lease.id;
      expect((grant as { lease: { ownerId: string } }).lease.ownerId).toBe("agent-7");
      expect(leaseIndex.ownerId(gatewayLeaseId)).toBe("agent-7");
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
      // `noWait: true` matters here: with no worker connected, an ordinary "wait" request would
      // sit in the fleet queue forever and hang this test rather than answer promptly.
      "lease.request": { model: "iPhone 17", noWait: true, platform: "ios" },
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
