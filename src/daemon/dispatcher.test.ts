import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  CleanupReaper,
  Doctor,
  FakeDriver,
  LeaseEngine,
  Registry,
  type Config,
} from "../core/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
} from "../ports/index.js";
import { TokenStore } from "../http/token-store.js";
import type { DispatchSession } from "./dispatcher.js";
import { Dispatcher, DispatchError } from "./dispatcher.js";

const gibibyte = 1024 ** 3;

/**
 * ADR 0003 §12: "full contract coverage at the dispatcher: one suite ... against a fake driver
 * and a scripted session, covering parsing, role rejection, ownership, and error codes." This
 * suite drives `Dispatcher` directly -- no socket, no `DaemonServer` -- against a real
 * `LeaseEngine`/`Registry`/`CleanupReaper` backed by `FakeDriver`, the same harness style
 * `server.test.ts` uses for its own socket-level tests. It deliberately does not re-walk every
 * operation the way `server.test.ts` already does at the framing/connection level (ADR §12:
 * "re-walking every operation through each transport would test nothing new") -- this suite is
 * where the actual role/ownership/parsing logic gets proven once, not per transport.
 */
async function buildDispatcher(
  overrides: {
    readonly downloadsPolicy?: Config["downloads"]["policy"];
    readonly awaitReady?: () => Promise<void>;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const filesystem = new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const config = testConfig(overrides.downloadsPolicy);
  const engine = new LeaseEngine({
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem,
    registry,
  });
  const doctor = new Doctor({
    claims: engine.claimReader,
    clock,
    config,
    drivers: [driver],
    eventBus,
    leaseExpirer: engine,
    quarantine: engine,
    registry,
  });
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator: sequence(),
    path: "/tokens.json",
    secrets: new CryptoTokenSecrets(),
  });
  const dispatcher = new Dispatcher({
    awaitReady: overrides.awaitReady ?? (() => Promise.resolve()),
    capacity: engine,
    catalog: engine,
    clock,
    config,
    doctor,
    eventBus,
    health: () => "running",
    leases: engine,
    queue: engine,
    reaper,
    registry,
    tokens,
  });
  return { clock, dispatcher, driver, engine, eventBus, registry, tokens };
}

function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    heartbeatCapability: false,
    heldLeaseIds: new Set(),
    manageEventSubscription: () => undefined,
    principal: "tok_agent",
    role: "agent",
    ...overrides,
  };
}

describe("Dispatcher: parsing", () => {
  it("rejects a malformed input with BAD_REQUEST before the handler runs", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("lease.request", { platform: "ios" }, session()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects ttlMs on a held lease.request with BAD_REQUEST (contract-level rule)", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 },
        session(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an operation this dispatcher has no handler for with UNKNOWN_REQUEST", async () => {
    const { dispatcher } = await buildDispatcher();
    // "daemon.stop" is ADR §6's frozen exception -- `DaemonServer#dispatchLine` intercepts it
    // before it ever reaches a `Dispatcher`, so this dispatcher genuinely has no handler for it.
    await expect(
      dispatcher.dispatch("daemon.stop", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" });
  });
});

describe("Dispatcher: token.create | token.list | token.revoke", () => {
  it("creates a token, lists it, then revokes it -- admin only", async () => {
    const { dispatcher, tokens } = await buildDispatcher();
    const admin = session({ role: "admin" });

    await expect(
      dispatcher.dispatch("token.create", { role: "agent" }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await dispatcher.dispatch(
      "token.create",
      { role: "operator", label: "ci" },
      admin,
    );
    expect(created.token.role).toBe("operator");
    expect(created.token.label).toBe("ci");
    expect(typeof created.secret).toBe("string");

    const listed = await dispatcher.dispatch("token.list", {}, admin);
    expect(listed.tokens.map((token) => token.id)).toEqual([created.token.id]);

    const revoked = await dispatcher.dispatch("token.revoke", { id: created.token.id }, admin);
    expect(revoked.revoked).toBe(true);
    expect((await tokens.list()).length).toBe(0);
  });

  it("revoking an unknown token id returns revoked: false rather than throwing", async () => {
    const { dispatcher } = await buildDispatcher();
    const result = await dispatcher.dispatch(
      "token.revoke",
      { id: "tok_does-not-exist" },
      session({ role: "admin" }),
    );
    expect(result.revoked).toBe(false);
  });
});

describe("Dispatcher: role rejection", () => {
  it("rejects an admin-only operation from an agent session with FORBIDDEN", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admits the same admin-only operation for an admin session", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
    ).resolves.toEqual([]);
  });

  it("doctor.run's role depends on its own input: fix:false is agent, fix:true is admin", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("doctor.run", { fix: false }, session({ role: "agent" })),
    ).resolves.toBeDefined();
    await expect(
      dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "admin" })),
    ).resolves.toBeDefined();
  });
});

describe("Dispatcher: ownership", () => {
  async function grantLease(dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"]) {
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", mode: "detached", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    return (grant as { lease: { id: string } }).lease.id;
  }

  it("lease.renew: rejects a non-owner with FORBIDDEN, admits the owner, admin bypasses", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.renew", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ id: leaseId });
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "admin" }),
      ),
    ).resolves.toMatchObject({ id: leaseId });
  });

  it("lease.release: rejects a non-owner with FORBIDDEN, admits the owner", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.release",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.release", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ leaseId });
  });

  it("lease.list: an agent sees only its own leases, admin sees all", async () => {
    const { dispatcher } = await buildDispatcher();
    await grantLease(dispatcher);

    const own = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_owner", role: "agent" }),
    );
    expect(own.leases).toHaveLength(1);

    const otherAgent = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_other", role: "agent" }),
    );
    expect(otherAgent.leases).toHaveLength(0);

    const admin = await dispatcher.dispatch("lease.list", {}, session({ role: "admin" }));
    expect(admin.leases).toHaveLength(1);
  });

  it("lease.cancel: rejects an agent naming a different requesterId with FORBIDDEN, admits an admin", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // An omitted requesterId always passes (defaults to the principal) -- see the operation's
    // `authorize` hook doc in `operations.ts`.
    await expect(
      dispatcher.dispatch("lease.cancel", {}, session({ principal: "tok_agent", role: "agent" })),
    ).resolves.toMatchObject({ result: "not-found" });

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_admin", role: "admin" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });
  });
});

describe("Dispatcher: error codes", () => {
  it("wraps a malformed request as DispatchError with the BAD_REQUEST code", async () => {
    const { dispatcher } = await buildDispatcher();
    try {
      await dispatcher.dispatch("lease.request", {}, session());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DispatchError);
      expect((error as DispatchError).code).toBe("BAD_REQUEST");
    }
  });

  it("lets a domain error (e.g. RUNTIME_MISSING) propagate untouched from the handler", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "99.0", platform: "ios" },
        session(),
      ),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
  });
});

describe("Dispatcher: the download policy clamp applies regardless of caller", () => {
  // This is the exact behaviour ADR 0003 §2 says HTTP was missing ("the socket path applies
  // `config.downloads.policy`, HTTP passes `allowDownload` through unclamped"). Since HTTP now
  // calls this same `lease.request` handler (see `src/http/tracker.ts`), proving the clamp
  // here proves it for both frontends -- there is exactly one implementation of it left.
  it("clamps allowDownload:true to false when downloads.policy is 'never'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "never" });
    await dispatcher.dispatch(
      "lease.request",
      { allowDownload: true, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const resolveCalls = driver.calls.filter((call) => call.operation === "resolveSpec");
    expect(resolveCalls.at(-1)?.arguments[1]).toMatchObject({ allowDownload: false });
  });

  it("leaves allowDownload:true untouched when downloads.policy is 'on-request'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "on-request" });
    await dispatcher.dispatch(
      "lease.request",
      { allowDownload: true, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const resolveCalls = driver.calls.filter((call) => call.operation === "resolveSpec");
    expect(resolveCalls.at(-1)?.arguments[1]).toMatchObject({ allowDownload: true });
  });
});

describe("Dispatcher: startup-readiness parking", () => {
  it("parks every operation but status.get on awaitReady", async () => {
    let releaseReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { dispatcher } = await buildDispatcher({ awaitReady: () => readyPromise });

    let statusSettled = false;
    void dispatcher.dispatch("status.get", {}, session()).then(() => {
      statusSettled = true;
    });
    await flush();
    expect(statusSettled).toBe(true);

    let catalogSettled = false;
    void dispatcher.dispatch("catalog.get", {}, session()).then(() => {
      catalogSettled = true;
    });
    await flush();
    expect(catalogSettled).toBe(false);

    releaseReady();
    await flush();
    expect(catalogSettled).toBe(true);
  });
});

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(downloadsPolicy: Config["downloads"]["policy"] = "on-request"): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    downloads: { policy: downloadsPolicy, acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 5_000 },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 2, maxRunning: 2 },
          maxRunning: 3,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}
