import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDriver } from "../core/testing.js";
import type { StateDatabase } from "../state/index.js";
import { type EventEnvelope } from "../bus/index.js";
import {
  HOUR,
  plainProjection,
  removeUsageRigs,
  requested,
  T0,
  usageRig,
} from "../history/testing.js";
import { type CatalogReader } from "../core/index.js";
import {
  OPERATIONS,
  statusDeviceSchema,
  WORKER_VIEW_CATALOG_EVENTS,
  WORKER_VIEW_REFRESH_INTERVAL_MS,
} from "../contract/index.js";
import { FakeClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatcher.js";
import { Dispatcher, DispatchError } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import {
  HOST_SYSTEM,
  buildDispatcher,
  flushPromises,
  gibibyte,
  session,
} from "./test-dispatcher.js";

const threads = vi.hoisted(() => ({
  crashOnPost: false,
  posts: [] as unknown[],
  workers: [] as { terminate(): Promise<number> }[],
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      threads.workers.push(this);
    }

    override postMessage(...args: Parameters<InstanceType<typeof actual.Worker>["postMessage"]>) {
      threads.posts.push(args[0]);
      super.postMessage(...args);
      if (threads.crashOnPost) void this.terminate();
    }
  }
  return { ...actual, Worker: CountingWorker };
});

class SettableClock extends FakeClock {
  #offset = 0;

  setBack(ms: number): void {
    this.#offset -= ms;
  }

  override now(): number {
    return super.now() + this.#offset;
  }
}

describe("Dispatcher: parsing", () => {
  it("rejects a malformed input with BAD_REQUEST before the handler runs", async () => {
    const { dispatcher, registry } = await buildDispatcher();
    const rejection = dispatcher.dispatch("lease.request", { model: "iPhone 17" }, session());
    await expect(rejection).rejects.toBeInstanceOf(DispatchError);
    await expect(rejection).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.leaseRequests()).toEqual([]);
  });

  it("rejects a lease.request naming both a class and a model with BAD_REQUEST, the message naming both fields", async () => {
    const { dispatcher, registry } = await buildDispatcher();

    const rejection = dispatcher.dispatch(
      "lease.request",
      { class: "phone", model: "iPhone 17 Pro", platform: "ios" },
      session(),
    );

    await expect(rejection).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/class.*model|model.*class/s),
    });
    expect(registry.snapshot.leases).toEqual([]);
  });

  it.each([
    ["android", { emulator: { headless: true } }],
    ["emulator", { headless: true }],
  ])(
    "rejects a lease.request carrying an %s field with BAD_REQUEST: emulator launch options are config-only",
    async (field, value) => {
      const { dispatcher } = await buildDispatcher();
      const valid = { model: "Pixel 8", osVersion: "34", platform: "android" };
      expect(OPERATIONS["lease.request"].input.safeParse(valid).success).toBe(true);

      await expect(
        dispatcher.dispatch("lease.request", { ...valid, [field]: value }, session()),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );

  it("rejects a requesterId with a control character or longer than 256 characters on lease.request, lease.cancel, device.exec and device.rotate with BAD_REQUEST, and accepts one at 256 or a gateway-namespaced one", async () => {
    const { dispatcher, registry } = await buildDispatcher();
    const send = (
      operation: "lease.request" | "lease.cancel" | "device.exec" | "device.rotate",
      requesterId: string,
    ) =>
      dispatcher.dispatch(
        operation,
        operation === "lease.request"
          ? { model: "iPhone 17 Pro", platform: "ios", requesterId }
          : operation === "lease.cancel"
            ? { requesterId }
            : operation === "device.rotate"
              ? { leaseId: "lse_none", orientation: "portrait", requesterId }
              : { args: [], leaseId: "lse_none", requesterId, tool: "simctl" },
        session({ role: "admin" }),
      );
    const bad = ["a\u001bb", "a\u0000b", "a\u009bb", "a\nb", "a\u007fb", "x".repeat(257)];
    for (const operation of [
      "lease.request",
      "lease.cancel",
      "device.exec",
      "device.rotate",
    ] as const) {
      for (const requesterId of bad) {
        await expect(
          send(operation, requesterId),
          `${operation} ${JSON.stringify(requesterId)}`,
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
    }
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios" },
        session({ principal: "a\u001b[2Jb", role: "admin" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(registry.snapshot.leases).toEqual([]);

    await expect(send("lease.cancel", "x".repeat(256))).resolves.toEqual({ result: "not-found" });
    await expect(send("lease.cancel", `gw:inst-1:${"x".repeat(256)}`)).resolves.toEqual({
      result: "not-found",
    });
  });

  it("rejects a ttlMs above lease.maxTtlMs on a request, rather than clamping it, and creates no lease", async () => {
    const { dispatcher, registry } = await buildDispatcher({
      lease: { defaultTtlMs: 1_000, maxTtlMs: 1_000 },
    });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_001 },
        session(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(registry.snapshot.leases).toEqual([]);
  });

  it("rejects a ttlMs above lease.maxTtlMs on a renew too, leaving the lease's deadline as it was", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      lease: { defaultTtlMs: 1_000, maxTtlMs: 1_000 },
    });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 },
      session(),
    );
    clock.advance(10);

    await expect(
      dispatcher.dispatch("lease.renew", { leaseId: grant.lease.id, ttlMs: 1_001 }, session()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(registry.snapshot.leases).toMatchObject([{ ttlDeadline: grant.lease.ttlDeadline }]);
  });

  it("accepts a ttlMs at the cap on a request (ADR 0004 §4)", async () => {
    const { dispatcher } = await buildDispatcher({
      lease: { defaultTtlMs: 1_000, maxTtlMs: 1_000 },
    });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 },
        session(),
      ),
    ).resolves.toMatchObject({ lease: { ttlMs: 1_000 } });
  });

  it("names the stored request to the session on lease.request, and replays it under the same idempotency key", async () => {
    const { dispatcher } = await buildDispatcher();
    const admitted: [string, boolean][] = [];
    const input = { idempotencyKey: "key-1", model: "iPhone 17 Pro", platform: "ios" } as const;
    const track = session({ onRequestAdmitted: (id, replayed) => admitted.push([id, replayed]) });

    const first = await dispatcher.dispatch("lease.request", input, track);
    const repeat = await dispatcher.dispatch("lease.request", input, track);

    expect(repeat.lease.id).toBe(first.lease.id);
    expect(admitted).toEqual([
      [expect.stringMatching(/^req_/), false],
      [admitted[0]?.[0], true],
    ]);
  });

  it("grants lease.request's leaseId as the lease ID, and answers an ID that is in use with LEASE_ID_TAKEN carrying it in details", async () => {
    const { dispatcher } = await buildDispatcher();
    const input = { leaseId: "ad-7f3a", model: "iPhone 17 Pro", platform: "ios" } as const;

    const first = await dispatcher.dispatch("lease.request", input, session());
    const clash = dispatcher.dispatch("lease.request", input, session({ principal: "other" }));

    expect(first.lease).toMatchObject({ id: "ad-7f3a", idChosenByRequester: true });
    await expect(clash).rejects.toMatchObject({
      code: "LEASE_ID_TAKEN",
      details: { leaseId: "ad-7f3a" },
    });
  });

  it("rejects an operation this dispatcher has no handler for with UNKNOWN_REQUEST", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("daemon.stop", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" });
  });
});

describe("Dispatcher: the fleet operations on a worker", () => {
  const admin = session({ principal: "operator", role: "admin" });

  it("worker.list on a worker returns one view whose id is the instance id", async () => {
    const { clock, dispatcher } = await buildDispatcher();
    clock.advance(500);

    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      connection: "connected",
      drained: false,
      id: "instance-1",
      lastSeenAt: 1_500,
      version: "1.2.3",
    });
    expect(workers[0]).not.toHaveProperty("protocol");
  });

  it("catalog.get reports the iOS slim categories and the default mode", async () => {
    for (const defaultMode of ["slim", "full"] as const) {
      const { dispatcher } = await buildDispatcher({
        driverOptions: { knownModels: ["iPhone 17"], slimCategories: ["store"] },
        iosDefaultMode: defaultMode,
      });

      const { platforms } = await dispatcher.dispatch("catalog.get", {}, admin);

      expect(platforms).toHaveLength(1);
      expect(platforms[0], defaultMode).toMatchObject({
        defaultMode,
        platform: "ios",
        slimCategories: ["store"],
      });
    }
  });

  it("a worker's own worker.list carries its load with readAt taken when its status answered, not after its catalog read", async () => {
    const clock = new FakeClock(10_000);
    const base = await buildDispatcher({ clock });
    const slowCatalog: CatalogReader = {
      async listCatalog(...arguments_) {
        // why: a later macrotask, so status's own answer has already been taken by then.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        clock.advance(5_000);
        return base.engine.listCatalog(...arguments_);
      },
    };
    const { dispatcher } = await buildDispatcher({
      catalog: slowCatalog,
      clock,
      load: () => ({ ageMs: 2_000, disk: { freeBytes: 120, totalBytes: 500 } }),
    });

    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(workers[0]?.load).toEqual({ disk: { freeBytes: 120, totalBytes: 500 }, readAt: 8_000 });
  });

  it("worker.list on a worker carries gateway.label as label, and no label when it is unset", async () => {
    const labelled = await buildDispatcher({ gatewayLabel: "mac-mini-1" });
    const unlabelled = await buildDispatcher();

    const withLabel = await labelled.dispatcher.dispatch("worker.list", {}, admin);
    const withoutLabel = await unlabelled.dispatcher.dispatch("worker.list", {}, admin);

    expect(withLabel.workers[0]?.label).toBe("mac-mini-1");
    expect(withoutLabel.workers[0]).not.toHaveProperty("label");
  });

  it("worker.list on a worker reads the driver's catalog once per refresh interval, not on every call", async () => {
    const { clock, dispatcher, driver } = await buildDispatcher();
    const catalogReads = vi.spyOn(driver, "listCatalog");

    // why: calls arrive every second; every call up to the last millisecond of the interval
    // answers from the one read.
    await dispatcher.dispatch("worker.list", {}, admin);
    for (let elapsed = 1_000; elapsed < WORKER_VIEW_REFRESH_INTERVAL_MS; elapsed += 1_000) {
      clock.advance(1_000);
      await dispatcher.dispatch("worker.list", {}, admin);
    }
    clock.advance(999);
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(2);
  });

  it("worker.list on a worker shares one catalog read between calls that arrive while it runs", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    const catalogReads = vi.spyOn(driver, "listCatalog");

    await Promise.all([
      dispatcher.dispatch("worker.list", {}, admin),
      dispatcher.dispatch("worker.list", {}, admin),
      dispatcher.dispatch("worker.list", {}, admin),
    ]);

    expect(catalogReads).toHaveBeenCalledTimes(1);
  });

  it("worker.list on a worker reads the catalog again when the clock is set back", async () => {
    const clock = new SettableClock(100_000);
    const { dispatcher, driver } = await buildDispatcher({ clock });
    const catalogReads = vi.spyOn(driver, "listCatalog");
    await dispatcher.dispatch("worker.list", {}, admin);

    clock.setBack(60_000);
    await dispatcher.dispatch("worker.list", {}, admin);

    expect(catalogReads).toHaveBeenCalledTimes(2);
  });

  it("worker.list on a worker re-reads its catalog on each event a gateway re-reads a worker's catalog on, until disposed", async () => {
    const { dispatcher, driver, eventBus } = await buildDispatcher();
    const catalogReads = vi.spyOn(driver, "listCatalog");
    const payload = {
      alreadyPresent: false,
      componentId: "27.0",
      durationMs: 1,
      platform: "ios",
      version: "27.0",
    };
    expect(WORKER_VIEW_CATALOG_EVENTS).toEqual(["component.installed"]);
    await dispatcher.dispatch("worker.list", {}, admin);

    eventBus.emit("component.installed", payload, "test");
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(2);

    dispatcher.dispose();
    await dispatcher.dispatch("worker.list", {}, admin);
    eventBus.emit("component.installed", payload, "test");
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(3);
  });

  it("worker.list on a worker lists a runtime installed since its last read, without waiting for the interval", async () => {
    const { components, dispatcher } = await buildDispatcher();
    const runtimes = async () =>
      (await dispatcher.dispatch("worker.list", {}, admin)).workers[0]?.catalog?.flatMap(
        (entry) => entry.runtimes,
      );
    expect(await runtimes()).toEqual(["26.5"]);

    await components.install({ component: "27.0", platform: "ios" });

    expect(await runtimes()).toEqual(expect.arrayContaining(["26.5", "27.0"]));
  });

  it("worker.list on a worker reads the catalog again after a read that failed", async () => {
    let calls = 0;
    const { dispatcher } = await buildDispatcher({
      catalog: {
        listCatalog: async () => {
          calls += 1;
          if (calls === 1) throw new Error("the catalog could not be read");
          return [
            {
              defaultRuntime: "26.5",
              modelAliases: {},
              classDefaults: {},
              modelClasses: {},
              models: [],
              modelRuntimes: {},
              platform: "ios",
              runtimes: ["26.5"],
            },
          ];
        },
      },
    });

    await expect(dispatcher.dispatch("worker.list", {}, admin)).rejects.toThrow(
      "the catalog could not be read",
    );
    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(calls).toBe(2);
    expect(workers[0]?.catalog?.flatMap((entry) => entry.runtimes)).toEqual(["26.5"]);
  });

  it("an admin reads the config and sees ios.full.bootTimeoutMs and android.bootTimeoutMs", async () => {
    const configured = await buildDispatcher({
      bootTimeouts: { android: 600_000, iosFull: 400_000 },
    });

    const config = await configured.dispatcher.dispatch("config.get", {}, admin);

    expect([config.ios["full"], config.android["bootTimeoutMs"]]).toEqual([
      { bootTimeoutMs: 400_000 },
      600_000,
    ]);
  });

  it("worker.list on a worker reports the same capacity, devices, leases, catalog, host and installs as its own reads", async () => {
    const { components, dispatcher, driver } = await buildDispatcher({
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
      hostFacts: () => ({
        ...HOST_SYSTEM,
        tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
      }),
    });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", platform: "ios" },
      session(),
    );
    driver.holdInstalls();
    void components.install({ component: "27.0", platform: "ios" });
    await flushPromises();

    const [{ workers }, status, devices, catalog, config] = await Promise.all([
      dispatcher.dispatch("worker.list", {}, admin),
      dispatcher.dispatch("status.get", {}, admin),
      dispatcher.dispatch("list.get", { kind: "devices" }, admin),
      dispatcher.dispatch("catalog.get", {}, admin),
      dispatcher.dispatch("config.get", {}, admin),
    ]);

    expect(status.leases).toHaveLength(1);
    expect(status.installs).toHaveLength(1);
    expect(status.host.tools).toHaveLength(1);
    expect(status.warmPool).toBeDefined();
    expect(catalog.platforms[0]?.models).toEqual(["iPhone 17 Pro"]);
    expect(workers[0]).toMatchObject({
      warmPool: status.warmPool,
      capacity: status.capacity,
      catalog: catalog.platforms,
      devices: statusDeviceSchema.array().parse(devices),
      downloads: { policy: config.downloads.policy, timeoutMs: config.downloads.timeoutMs },
      health: status.daemon.health,
      host: status.host,
      installs: status.installs,
      lease: { maxTtlMs: config.lease.maxTtlMs },
      leases: status.leases,
      queueDepth: status.queueDepth,
    });
    expect(workers[0]?.devices).toHaveLength(1);
    expect(workers[0]?.devices?.[0]).not.toHaveProperty("driverData");
  });

  it("worker.drain, worker.undrain, worker.remove, worker.update, worker.install-component and alerts.test on a worker fail with UNSUPPORTED_IN_WORKER_MODE", async () => {
    const { components, dispatcher } = await buildDispatcher();
    const install = vi.spyOn(components, "install");
    const calls = [
      ["worker.drain", { workerId: "instance-1" }],
      ["worker.undrain", { workerId: "instance-1" }],
      ["worker.remove", { workerId: "instance-1" }],
      ["worker.update", { workerId: "instance-1" }],
      ["worker.install-component", { platform: "ios", version: "27.0", workers: "all" }],
      ["alerts.test", { destination: "ops" }],
    ] as const;

    const refusals = await Promise.all(
      calls.map(([operation, input]) =>
        dispatcher.dispatch(operation, input, admin).then(
          () => ({ operation, outcome: "answered" }),
          (error: unknown) => ({ error, operation }),
        ),
      ),
    );

    expect(refusals).toEqual(
      calls.map(([operation]) => ({
        error: expect.objectContaining({
          code: "UNSUPPORTED_IN_WORKER_MODE",
          details: { operation },
        }),
        operation,
      })),
    );
    expect(install).not.toHaveBeenCalled();
    expect(String((refusals[4] as { error?: unknown } | undefined)?.error)).toContain(
      "install on this host without naming workers",
    );
    expect((refusals[5] as { error?: Error } | undefined)?.error?.message).toBe(
      "alerts.test sends to a gateway's alert destinations, and this daemon is not a gateway; run it against the gateway",
    );
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

describe("Dispatcher: identity.get", () => {
  it("copies signOutUrl from a session that has one into its output, and omits it otherwise", async () => {
    const { dispatcher } = await buildDispatcher();

    const withUrl = await dispatcher.dispatch(
      "identity.get",
      {},
      session({ role: "admin", via: "proxy", signOutUrl: "https://sso.example/logout" }),
    );
    const without = await dispatcher.dispatch(
      "identity.get",
      {},
      session({ role: "admin", via: "socket" }),
    );

    expect(withUrl).toHaveProperty("signOutUrl", "https://sso.example/logout");
    expect(without).not.toHaveProperty("signOutUrl");
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

  it("doctor.run forwards purgeOrphans to the Doctor, distinctly from fix, and always asks for prerequisites", async () => {
    const { dispatcher, doctor } = await buildDispatcher();
    const reconcile = vi.spyOn(doctor, "reconcile");

    await dispatcher.dispatch("doctor.run", {}, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({
      fix: false,
      prerequisites: true,
      purgeOrphans: false,
    });

    await dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({
      fix: true,
      prerequisites: true,
      purgeOrphans: false,
    });

    await dispatcher.dispatch("doctor.run", { purgeOrphans: true }, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({
      fix: false,
      prerequisites: true,
      purgeOrphans: true,
    });
  });

  it("doctor.run answers a driver-unavailable finding with its reason and detail while iOS is refused", async () => {
    const cases = [
      {
        reason: "invalid-device-set",
        root: "Default",
        summary: "Refusing the ios device set: bad",
      },
      {
        reason: "device-set-changed",
        root: "/Volumes/sims",
        summary: "Refusing the ios device set: left",
      },
    ] as const;
    for (const { reason, root, summary } of cases) {
      const { dispatcher } = await buildDispatcher({
        driverRejections: [
          {
            event: "driver.root-rejected",
            payload: { platform: "ios", reason, root },
            platform: "ios",
            reason,
            summary,
          },
        ],
      });

      const report = (await dispatcher.dispatch("doctor.run", {}, session({ role: "admin" }))) as {
        findings: { kind: string; platform?: string; reason?: string; detail?: string }[];
      };

      const finding = report.findings.find((entry) => entry.kind === "driver-unavailable");
      expect(finding, reason).toMatchObject({
        kind: "driver-unavailable",
        platform: "ios",
        reason,
      });
      expect(finding?.detail, reason).toContain(summary);
    }
  });

  it("driver.passthrough resolves the scoped command through the driver that claims the tool", async () => {
    const { dispatcher } = await buildDispatcher({ passthroughTool: "simctl" });

    await expect(
      dispatcher.dispatch(
        "driver.passthrough",
        { args: ["list", "devices"], tool: "simctl" },
        session(),
      ),
    ).resolves.toEqual({
      args: ["--set", "/root", "list", "devices"],
      command: "simctl",
      env: { SIMLOCK_SCOPED: "1" },
    });
  });

  it("driver.passthrough refuses a tool no driver claims", async () => {
    const { dispatcher } = await buildDispatcher({ passthroughTool: "simctl" });

    await expect(
      dispatcher.dispatch("driver.passthrough", { args: ["devices"], tool: "adb" }, session()),
    ).rejects.toThrow(/No driver provides a adb passthrough/);
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

describe("Dispatcher: lease.release of a virtual device", () => {
  it.each([{ identity: "reusable" as const }, { identity: "fresh" as const }])(
    "deletes the device whatever lease.identity says ($identity), and the next lease.request gets another device",
    async ({ identity }) => {
      const { dispatcher, registry } = await buildDispatcher({
        lease: { identity: { android: identity, ios: identity } },
      });
      const request = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
      const first = await dispatcher.dispatch("lease.request", request, session());

      await dispatcher.dispatch("lease.release", { leaseId: first.lease.id }, session());
      await vi.waitFor(() => {
        expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["deleted"]);
      });
      const second = await dispatcher.dispatch("lease.request", request, session());

      expect(second.device.id).not.toBe(first.device.id);
      expect(registry.snapshot.devices.map((device) => [device.id, device.state])).toEqual([
        [first.device.id, "deleted"],
        [second.device.id, "leased"],
      ]);
    },
  );
});

describe("Dispatcher: baseline.save", () => {
  it("ends the held lease, saves its device as version 1 of the named baseline with the files it held, and deletes the device", async () => {
    const { clock, dispatcher, driver, eventBus, registry } = await buildDispatcher();
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/login.txt", "signed in");

    const saved = await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "checkout", note: "app 4.2" },
      session({ role: "admin" }),
    );

    expect(saved).toEqual({
      baseline: {
        mode: "full",
        model: "iPhone 17 Pro",
        name: "checkout",
        note: "app 4.2",
        osVersion: "26.5",
        platform: "ios",
        savedAt: new Date(clock.now()).toISOString(),
        sizeBytes: "signed in".length,
        version: 1,
      },
      leaseId: grant.lease.id,
    });
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["deleted"]);
    const [source] = await driver.listSources();
    expect(driver.sourceFiles(source?.id ?? "")).toEqual(
      new Map([["data/login.txt", "signed in"]]),
    );
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "lease.released")
        .map((envelope) => envelope.payload),
    ).toMatchObject([{ leaseId: grant.lease.id, reason: "explicit" }]);
  });

  it("records the image tag the saved device carries when its lease named none, so a lease naming that tag is granted and another tag is refused", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: {
        availableOsVersions: ["34"],
        defaultImageTag: "google_apis_playstore",
        images: [
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
        ],
        platform: "android",
      },
    });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "Pixel 8", osVersion: "34", platform: "android" },
      session(),
    );
    const admin = session({ role: "admin" });

    const saved = await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "android-test" },
      admin,
    );
    const listed = await dispatcher.dispatch("baseline.list", {}, admin);
    const named = { baseline: "android-test", platform: "android" };
    const granted = await dispatcher.dispatch(
      "lease.request",
      { ...named, imageTag: "google_apis_playstore" },
      session(),
    );
    await dispatcher.dispatch("lease.release", { leaseId: granted.lease.id }, session());
    const refused = await dispatcher
      .dispatch("lease.request", { ...named, imageTag: "google_apis" }, session())
      .catch((caught: unknown) => caught);

    expect(saved.baseline.imageTag).toBe("google_apis_playstore");
    expect(listed.baselines.map((entry) => entry.imageTag)).toEqual(["google_apis_playstore"]);
    expect(granted.device.spec.baseline).toEqual({ name: "android-test", version: 1 });
    expect(refused).toMatchObject({
      message:
        "baseline android-test is image tag google_apis_playstore, the request asks for google_apis",
    });
  });
});

describe("Dispatcher: baseline.save versions", () => {
  it("numbers each save under one name one more than the last, one at a time or two at once, and keeps only the newest version's source", async () => {
    const { dispatcher, driver, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const lease = async (who: string): Promise<string> => {
      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session({ principal: who }),
      );
      const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
      driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/who", who);
      return grant.lease.id;
    };
    const save = (leaseId: string) =>
      dispatcher.dispatch("baseline.save", { leaseId, name: "checkout" }, admin);
    const keptSources = async () =>
      (await driver.listSources()).map((source) => driver.sourceFiles(source.id));

    const first = await save(await lease("tok_a"));
    const second = await save(await lease("tok_b"));
    expect([first.baseline.version, second.baseline.version]).toEqual([1, 2]);
    expect(await keptSources()).toEqual([new Map([["data/who", "tok_b"]])]);

    const [c, d] = [await lease("tok_c"), await lease("tok_d")];
    const results = await Promise.all([save(c), save(d)]);
    expect(results.map((result) => result.baseline.version).sort()).toEqual([3, 4]);
    const newest =
      results.find((result) => result.baseline.version === 4)?.leaseId === c ? "tok_c" : "tok_d";
    expect(await keptSources()).toEqual([new Map([["data/who", newest]])]);
  });
});

describe("Dispatcher: baseline.save and baseline.remove queue", () => {
  it("runs a remove sent during a save after it, so the remove deletes the version the save made", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { saveSource: 1_000 } },
    });
    const admin = session({ role: "admin" });
    const lease = async (): Promise<string> =>
      (
        await dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
          session(),
        )
      ).lease.id;
    const settled = async (...pending: Promise<unknown>[]): Promise<void> => {
      let open = pending.length;
      for (const promise of pending) void promise.then(() => (open -= 1));
      await vi.waitFor(() => {
        clock.advance(1_000);
        expect(open).toBe(0);
      });
    };
    const first = dispatcher.dispatch(
      "baseline.save",
      { leaseId: await lease(), name: "checkout" },
      admin,
    );
    await settled(first);

    const second = dispatcher.dispatch(
      "baseline.save",
      { leaseId: await lease(), name: "checkout" },
      admin,
    );
    const removed = dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin);
    await settled(second, removed);

    expect(await removed).toEqual({ deletedDevices: [], name: "checkout", versions: [2] });
    expect(await dispatcher.dispatch("baseline.list", {}, admin)).toEqual({ baselines: [] });
    expect(registry.snapshot.leases).toEqual([]);
  });
});

describe("Dispatcher: baseline.save and nuke", () => {
  it("makes nuke wait for a save in flight and remove its baseline, and answers a save queued behind nuke's maintenance with an unknown lease since nuke ended its lease", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { saveSource: 1_000 } },
      includeNuke: true,
    });
    const admin = session({ role: "admin" });
    const lease = async (who: string): Promise<string> =>
      (
        await dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
          session({ principal: who }),
        )
      ).lease.id;
    const [held, queued] = [await lease("tok_a"), await lease("tok_b")];
    const outcome = (promise: Promise<unknown>): { settled: boolean } => {
      const state = { settled: false };
      void promise.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      return state;
    };
    const saving = dispatcher.dispatch("baseline.save", { leaseId: held, name: "first" }, admin);
    const savingState = outcome(saving);
    await vi.waitFor(() => {
      expect(registry.snapshot.devices.map((device) => device.state)).toContain("reclaiming");
    });

    const nuking = dispatcher.dispatch("nuke.run", { deleteDevices: true }, admin);
    const nukeState = outcome(nuking);
    const blocked = dispatcher.dispatch(
      "baseline.save",
      { leaseId: queued, name: "second" },
      admin,
    );
    const blockedError = blocked.then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    await vi.waitFor(() => {
      clock.advance(1_000);
      expect(savingState.settled).toBe(true);
    });
    const [nuked, refusal] = await Promise.all([nuking, blockedError]);

    expect(nukeState.settled).toBe(true);
    expect(nuked).toMatchObject({ releasedLeaseIds: [queued], removedBaselines: ["first"] });
    expect(refusal).toMatchObject({ leaseId: queued, name: "UnknownLeaseError" });
    expect(await dispatcher.dispatch("baseline.list", {}, admin)).toEqual({ baselines: [] });
    expect(registry.snapshot.leases).toEqual([]);
  });
});

describe("Dispatcher: baseline.save failure", () => {
  it("answers BASELINE_SAVE_FAILED when the driver cannot save, with the lease ended, the device quarantined and no baseline recorded", async () => {
    const { dispatcher, driver, eventBus, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const request = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const grant = await dispatcher.dispatch("lease.request", request, session());
    driver.failOn("saveSource", 1, new Error("disk full"));

    const error = await dispatcher
      .dispatch("baseline.save", { leaseId: grant.lease.id, name: "checkout" }, admin)
      .then(
        () => undefined,
        (rejected: unknown) => rejected,
      );

    expect(error).toMatchObject({
      code: "BASELINE_SAVE_FAILED",
      details: { leaseId: grant.lease.id, name: "checkout" },
      message: `baseline checkout was not saved: disk full. Lease ${grant.lease.id} has ended.`,
    });
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["quarantined"]);
    expect(await driver.listSources()).toEqual([]);
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "device.quarantined")
        .map((envelope) => envelope.payload),
    ).toMatchObject([{ kind: "shutdown-failed" }]);
    const next = await dispatcher.dispatch("lease.request", request, session());
    const saved = await dispatcher.dispatch(
      "baseline.save",
      { leaseId: next.lease.id, name: "checkout" },
      admin,
    );
    expect(saved.baseline.version).toBe(1);
  });
});

describe("Dispatcher: baseline.save refusals", () => {
  it("refuses a bad name or note, a non-admin, an unknown lease and a physical lease, and ends no lease", async () => {
    const { dispatcher, driver, engine, registry } = await buildDispatcher({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          spec: { class: "tablet", model: "iPad Pro", osVersion: "18.4" },
          state: "ready",
        },
      ],
    });
    await engine.convergeRunningCapacity();
    driver.setPhysicalPresence("00008110-001A2B3C4D5E", true);
    const virtual = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const physical = await dispatcher.dispatch(
      "lease.request",
      { model: "iPad Pro", physical: true, platform: "ios" },
      session({ principal: "tok_physical" }),
    );
    const admin = session({ role: "admin" });
    const accepted = { leaseId: virtual.lease.id, name: "checkout" };
    expect(OPERATIONS["baseline.save"].input.safeParse(accepted).success).toBe(true);

    const refusals: readonly [string, unknown, DispatchSession, string, string?][] = [
      ["Checkout", { ...accepted, name: "Checkout" }, admin, "BAD_REQUEST"],
      ["-checkout", { ...accepted, name: "-checkout" }, admin, "BAD_REQUEST"],
      ["65 characters", { ...accepted, name: "a".repeat(65) }, admin, "BAD_REQUEST"],
      ["201-character note", { ...accepted, note: "n".repeat(201) }, admin, "BAD_REQUEST"],
      ["note with a newline", { ...accepted, note: "two\nlines" }, admin, "BAD_REQUEST"],
      ["an agent token", accepted, session({ role: "agent" }), "FORBIDDEN"],
      ["unknown lease", { ...accepted, leaseId: "lse_gone" }, admin, "UNKNOWN_LEASE"],
      [
        "physical lease",
        { ...accepted, leaseId: physical.lease.id },
        admin,
        "BAD_REQUEST",
        `lease ${physical.lease.id} is on a physical device; only a simulator or emulator can be saved as a baseline`,
      ],
    ];
    for (const [label, input, caller, code, message] of refusals) {
      const error = await dispatcher.dispatch("baseline.save", input as never, caller).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(classifyError(error), label).toBe(code);
      if (message !== undefined) expect((error as Error).message, label).toBe(message);
      expect(registry.snapshot.leases.map((lease) => lease.id).sort(), label).toEqual(
        [virtual.lease.id, physical.lease.id].sort(),
      );
    }
  });
});

describe("Dispatcher: baseline.list", () => {
  it("lists the newest version of each baseline by name with its spec, note, size, saved time and stale reason, cleared when the runtime is back, and an agent may list", async () => {
    const { clock, dispatcher, driver, registry } = await buildDispatcher();
    const agent = session({ role: "agent" });
    const admin = session({ role: "admin" });
    expect(await dispatcher.dispatch("baseline.list", {}, agent)).toEqual({ baselines: [] });
    const save = async (name: string, content: string, note?: string): Promise<void> => {
      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      );
      const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
      driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", content);
      await dispatcher.dispatch(
        "baseline.save",
        { leaseId: grant.lease.id, name, ...(note === undefined ? {} : { note }) },
        admin,
      );
    };
    await save("login", "signed in", "signed in");
    await save("checkout", "v1");
    await save("checkout", "version two");

    expect(await dispatcher.dispatch("baseline.list", {}, agent)).toEqual({
      baselines: [
        {
          mode: "full",
          model: "iPhone 17 Pro",
          name: "checkout",
          osVersion: "26.5",
          platform: "ios",
          savedAt: new Date(clock.now()).toISOString(),
          sizeBytes: "version two".length,
          version: 2,
        },
        {
          mode: "full",
          model: "iPhone 17 Pro",
          name: "login",
          note: "signed in",
          osVersion: "26.5",
          platform: "ios",
          savedAt: new Date(clock.now()).toISOString(),
          sizeBytes: "signed in".length,
          version: 1,
        },
      ],
    });

    const sources = await driver.listSources();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    const staleNames = async (): Promise<(string | undefined)[]> =>
      (await dispatcher.dispatch("baseline.list", {}, agent)).baselines.map(
        (baseline) => baseline.staleReason,
      );
    const [loginSource] = sources;
    driver.setSources(
      sources.map((source) =>
        source === loginSource ? { ...source, staleReason: reason } : source,
      ),
    );
    expect(await staleNames()).toEqual([undefined, reason]);
    driver.setSources(sources);
    expect(await staleNames()).toEqual([undefined, undefined]);
  });
});

describe("Dispatcher: baseline.list without a driver", () => {
  it("lists a baseline whose platform has no driver as stale, without storing the reason or recording an event", async () => {
    const { dispatcher, eventBus } = await buildDispatcher({
      seedState: ({ database }) => {
        database
          .prepare(
            "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES ('droid', 1, 'android', 'Pixel 9', '36', 'full', '2026-11-02T13:40:00.000Z', 'src-droid')",
          )
          .run();
      },
    });
    const agent = session({ role: "agent" });

    const listed = await dispatcher.dispatch("baseline.list", {}, agent);
    expect(listed.baselines).toMatchObject([
      { name: "droid", staleReason: "the android driver is not available on this worker" },
    ]);
    expect(eventBus.replay().filter((envelope) => envelope.event === "baseline.stale")).toEqual([]);
  });
});

/** why: #1207 writes a device's baseline at provision; until then a test writes the registry rows a remove reads. */
function seedBaselineRows(state: StateDatabase): void {
  const { database } = state;
  const spec = ["ios", "iPhone 17 Pro", "26.5", "full"];
  for (const [name, sourceId] of [
    ["login", "src-login"],
    ["checkout", "src-checkout"],
    ["busy", "src-busy"],
  ] as const) {
    database
      .prepare(
        "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES (?, 1, ?, ?, ?, ?, '2026-11-02T13:40:00.000Z', ?)",
      )
      .run(name, ...spec, sourceId);
  }
  for (const [id, fakeId, deviceState, baseline] of [
    ["dev_idle", "fake-ios-1", "shutdown", "checkout"],
    ["dev_idle_b", "fake-ios-4", "shutdown", "checkout"],
    ["dev_leased", "fake-ios-2", "leased", "busy"],
    ["dev_quarantined", "fake-ios-3", "quarantined", "login"],
  ] as const) {
    database
      .prepare(
        "INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version, mode, created_at, baseline_name, baseline_version) VALUES (?, 'ios', 0, ?, ?, 'iPhone 17 Pro', '26.5', 'full', 1, ?, 1)",
      )
      .run(id, fakeId, deviceState, baseline);
    database
      .prepare("INSERT INTO fake_device_data (device_id, fake_device_id) VALUES (?, ?)")
      .run(id, fakeId);
  }
  database
    .prepare(
      "INSERT INTO leases (id, device_id, requester_id, owner_id, granted_at, ttl_ms, ttl_deadline, last_renewed_at, id_chosen_by_requester) VALUES ('lse_busy', 'dev_leased', 'tok_a', 'tok_a', 1, 3600000, 3600001, 1, 0)",
    )
    .run();
}

describe("Dispatcher: baselines beside a gateway's worker view", () => {
  it("answers worker.list with the baselines its own baseline.list gives, and with none when no baseline service is wired", async () => {
    const { dispatcher, driver, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", "signed in");
    await dispatcher.dispatch("baseline.save", { leaseId: grant.lease.id, name: "login" }, admin);

    const { baselines } = await dispatcher.dispatch("baseline.list", {}, admin);
    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(baselines.map((baseline) => baseline.name)).toEqual(["login"]);
    expect(workers[0]?.baselines).toEqual(baselines);

    const bare = await buildDispatcher({ withoutBaselines: true });
    const listed = await bare.dispatcher.dispatch("worker.list", {}, admin);
    expect(listed.workers[0]).not.toHaveProperty("baselines");
  });

  it("refuses baseline.remove with a workerId, which names a gateway's worker", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "baseline.remove",
        { name: "login", workerId: "wrk_a" },
        session({ role: "admin" }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "workerId names a gateway's worker, and this daemon is not a gateway; remove without --worker",
    });
  });
});

describe("Dispatcher: baseline.remove", () => {
  it("removes an unused baseline with its source and the idle devices made from it, refuses one a lease uses, an unknown name and an agent", async () => {
    const { dispatcher, driver, engine, registry } = await buildDispatcher({
      seedState: seedBaselineRows,
    });
    const spec = {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      physical: false,
      platform: "ios",
    } as const;
    for (let count = 0; count < 4; count += 1) await driver.provision(spec);
    driver.setSources(
      ["login", "checkout", "busy"].map((name) => ({
        id: `src-${name}`,
        kind: "baseline" as const,
        model: "iPhone 17 Pro",
        osVersion: "26.5",
      })),
    );
    const admin = session({ role: "admin" });
    const refused = async (name: string, caller: DispatchSession): Promise<unknown> =>
      dispatcher.dispatch("baseline.remove", { name }, caller).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
    const listed = async (): Promise<string[]> =>
      (await dispatcher.dispatch("baseline.list", {}, admin)).baselines.map(({ name }) => name);

    expect(await refused("login", session({ role: "agent" }))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await refused("nothere", admin)).toMatchObject({
      code: "UNKNOWN_BASELINE",
      details: { name: "nothere" },
      message: 'no baseline named "nothere" on this worker',
    });
    expect(await refused("Checkout", admin)).toMatchObject({ code: "BAD_REQUEST" });
    expect(await refused("busy", admin)).toMatchObject({
      code: "BASELINE_IN_USE",
      details: { leaseId: "lse_busy", name: "busy" },
      message: "baseline busy is in use by lease lse_busy",
    });
    expect(await listed()).toEqual(["busy", "checkout", "login"]);

    expect(await dispatcher.dispatch("baseline.remove", { name: "login" }, admin)).toEqual({
      deletedDevices: [],
      name: "login",
      versions: [1],
    });
    expect(engine.claimReader.isClaimed("dev_quarantined")).toBe(false);
    // why: the first idle device's destroy throws; the second must still be disposed and no cleanup claim left held.
    driver.failOn("destroy", 1, new Error("destroy failed"));
    await expect(
      dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin),
    ).rejects.toThrow("destroy failed");
    expect(engine.claimReader.isClaimed("dev_idle")).toBe(false);
    expect(engine.claimReader.isClaimed("dev_idle_b")).toBe(false);
    expect(registry.snapshot.devices.map((device) => [device.id, device.state])).toContainEqual([
      "dev_idle_b",
      "deleted",
    ]);
    expect(await listed()).toEqual(["busy", "checkout"]);
    expect(await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin)).toEqual({
      deletedDevices: ["dev_idle"],
      name: "checkout",
      versions: [1],
    });

    expect(await listed()).toEqual(["busy"]);
    expect((await driver.listSources()).map((source) => source.id)).toEqual(["src-busy"]);
    expect(registry.snapshot.devices.map((device) => [device.id, device.state])).toEqual([
      ["dev_idle", "deleted"],
      ["dev_idle_b", "deleted"],
      ["dev_leased", "leased"],
      ["dev_quarantined", "quarantined"],
    ]);
  });
});

describe("Dispatcher: doctor baseline sources", () => {
  it("lists a baseline's source with its name and version, a ready baseline source no row names as an orphan only doctor --purge-orphans deletes, and finds a stale baseline", async () => {
    const { dispatcher, driver, eventBus, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", "abc");
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "checkout" },
      admin,
    );
    const [named] = await driver.listSources();
    const unnamed = {
      id: "left-over",
      kind: "baseline",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
    } as const;
    driver.setSources([named as NonNullable<typeof named>, unnamed]);

    const listed = await dispatcher.dispatch("doctor.run", {}, admin);
    expect(listed.findings).toEqual([]);
    expect(listed.sources).toEqual([
      {
        baselineName: "checkout",
        baselineVersion: 1,
        kind: "baseline",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        platform: "ios",
        sizeBytes: 3,
      },
      {
        kind: "baseline",
        model: "iPhone 17 Pro",
        orphan: true,
        osVersion: "26.5",
        platform: "ios",
      },
    ]);
    expect((await driver.listSources()).map((source) => source.id)).toContain("left-over");

    const purged = await dispatcher.dispatch("doctor.run", { purgeOrphans: true }, admin);
    expect(purged.sources.map((source) => source.orphan)).toEqual([undefined]);
    expect((await driver.listSources()).map((source) => source.id)).not.toContain("left-over");

    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    driver.setSources([{ ...(named as NonNullable<typeof named>), staleReason: reason }]);
    await dispatcher.dispatch("doctor.run", {}, admin);
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "baseline.stale")
        .map((envelope) => envelope.payload),
    ).toEqual([{ name: "checkout", reason, version: 1 }]);
  });
});

describe("Dispatcher: baseline events", () => {
  it("records baseline.saved, baseline.removed with its reason (nuke --delete-devices removes every baseline, plain nuke keeps them) and baseline.stale, once each, after the change is committed", async () => {
    const { dispatcher, driver, eventBus, registry, state } = await buildDispatcher({
      driverOptions: { componentSizes: { "27.0": 1_000 }, knownModels: ["iPhone 17 Pro"] },
      includeNuke: true,
    });
    const admin = session({ principal: "tok_admin", role: "admin" });
    // why: what the table held at the moment each event reached a subscriber, to prove the change is committed before the event.
    const seen: { removedRows: number[]; staleReasons: unknown[] } = {
      removedRows: [],
      staleReasons: [],
    };
    eventBus.subscribe("baseline.removed", ({ payload }) => {
      const row = state.database
        .prepare("SELECT COUNT(*) AS count FROM baselines WHERE name = ? AND version = ?")
        .get(payload.name, payload.version);
      seen.removedRows.push(Number(row?.count));
    });
    eventBus.subscribe("baseline.stale", ({ payload }) => {
      const row = state.database
        .prepare("SELECT stale_reason FROM baselines WHERE name = ? AND version = ?")
        .get(payload.name, payload.version);
      seen.staleReasons.push(row?.stale_reason);
    });
    await dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, admin);
    const events = (name: string): unknown[] =>
      eventBus
        .replay()
        .filter((envelope) => envelope.event === name)
        .map((envelope) => envelope.payload);
    const save = async (content: string, name = "checkout"): Promise<string> => {
      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      );
      const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
      driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", content);
      await dispatcher.dispatch("baseline.save", { leaseId: grant.lease.id, name }, admin);
      return grant.lease.id;
    };

    const first = await save("v1");
    expect(events("baseline.saved")).toEqual([
      {
        leaseId: first,
        mode: "full",
        model: "iPhone 17 Pro",
        name: "checkout",
        osVersion: "26.5",
        platform: "ios",
        requesterId: "tok_admin",
        sizeBytes: 2,
        version: 1,
      },
    ]);
    expect(events("device.deleted")).toMatchObject([{ initiator: "baseline-save" }]);
    expect(events("baseline.removed")).toEqual([]);

    await save("v2");
    expect(events("baseline.saved")).toHaveLength(2);
    expect(events("baseline.removed")).toEqual([
      { name: "checkout", reason: "replaced", requesterId: "tok_admin", version: 1 },
    ]);

    const [source] = await driver.listSources();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    const check = async (staleReason?: string): Promise<void> => {
      driver.setSources([
        {
          ...(source as NonNullable<typeof source>),
          ...(staleReason === undefined ? {} : { staleReason }),
        },
      ]);
      await dispatcher.dispatch("baseline.list", {}, admin);
    };
    await check(reason);
    await check(reason);
    expect(events("baseline.stale")).toEqual([{ name: "checkout", reason, version: 2 }]);
    await check();
    await check(reason);
    expect(events("baseline.stale")).toHaveLength(2);

    await check();
    driver.setSources([{ ...(source as NonNullable<typeof source>), staleReason: reason }]);
    await Promise.all([
      dispatcher.dispatch("baseline.list", {}, admin),
      dispatcher.dispatch("baseline.list", {}, admin),
    ]);
    expect(events("baseline.stale")).toHaveLength(3);
    await check();
    driver.setSources([{ ...(source as NonNullable<typeof source>), staleReason: reason }]);
    await dispatcher.dispatch("component.remove", { platform: "ios", version: "27.0" }, admin);
    await vi.waitFor(() => {
      expect(events("baseline.stale")).toHaveLength(4);
    });

    await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin);
    expect(events("baseline.removed")).toEqual([
      { name: "checkout", reason: "replaced", requesterId: "tok_admin", version: 1 },
      { name: "checkout", reason: "operator", requesterId: "tok_admin", version: 2 },
    ]);

    await save("again");
    await save("signed in", "login");
    expect(await dispatcher.dispatch("nuke.run", { deleteDevices: false }, admin)).toMatchObject({
      removedBaselines: [],
    });
    expect((await dispatcher.dispatch("baseline.list", {}, admin)).baselines).toHaveLength(2);
    driver.failOn(
      "destroySource",
      driver.calls.filter((call) => call.operation === "destroySource").length + 1,
      new Error("simctl delete failed"),
    );
    expect(await dispatcher.dispatch("nuke.run", { deleteDevices: true }, admin)).toMatchObject({
      removedBaselines: ["checkout", "login"],
    });
    expect(events("baseline.removed").slice(2)).toEqual([
      { name: "checkout", reason: "nuke", version: 1 },
      { name: "login", reason: "nuke", version: 1 },
    ]);
    expect(await dispatcher.dispatch("baseline.list", {}, admin)).toEqual({ baselines: [] });
    expect(await driver.listSources()).toHaveLength(1);
    expect(seen.removedRows).toEqual([0, 0, 0, 0]);
    expect(seen.staleReasons).toEqual([reason, reason, reason, reason]);
  });
});

describe("Dispatcher: events.replay", () => {
  it("events.replay with sinceTs returns what the event history returns", async () => {
    const fromHistory: EventEnvelope[] = [
      {
        id: "evt_7",
        seq: 7,
        timestamp: 50,
        event: "daemon.stopping",
        payload: { reason: "x" },
        module: "d",
      },
    ];
    const asked: unknown[] = [];
    const { dispatcher } = await buildDispatcher({
      eventHistory: {
        replay: async (input) => {
          asked.push(input);
          return fromHistory;
        },
        replayPage: async () => ({ events: [], kind: "events" }),
        status: () => ({ opened: true, writing: true }),
      },
    });

    await expect(
      dispatcher.dispatch("events.replay", { sinceTs: 10 }, session({ role: "admin" })),
    ).resolves.toEqual(fromHistory);
    expect(asked).toEqual([{ sinceTs: 10 }]);
  });
});

describe("Dispatcher: events.replay paging", () => {
  afterEach(removeUsageRigs);

  const admin = session({ role: "admin" });

  async function pagedRig(
    rows: number,
    options: Parameters<typeof usageRig>[0] = {},
  ): Promise<{
    readonly rig: Awaited<ReturnType<typeof usageRig>>;
    readonly ids: string[];
    readonly dispatcher: Dispatcher;
  }> {
    const rig = await usageRig(options);
    for (let row = 0; row < rows; row += 1) {
      rig.at(T0 + row);
      rig.emit("daemon.stopping", { reason: `r${row + 1}` });
    }
    const { dispatcher } = await buildDispatcher({ eventHistory: rig.history });
    return { dispatcher, ids: rig.bus.replay().map((event) => event.id), rig };
  }

  const reasons = (events: readonly { readonly payload?: unknown }[]): unknown[] =>
    events.map((event) => (event.payload as { reason: string }).reason);

  it("events.replay with beforeId and limit pages through the worker dispatcher over a real history: the page, HISTORY_NOT_KEPT, an empty table, HISTORY_UNAVAILABLE, and 100 at most for beforeId alone", async () => {
    const { dispatcher, ids } = await pagedRig(150);
    const page = await dispatcher.dispatch(
      "events.replay",
      { beforeId: ids[4] as string, limit: 2 },
      admin,
    );
    expect(reasons(page)).toEqual(["r3", "r4"]);
    const unbounded = await dispatcher.dispatch(
      "events.replay",
      { beforeId: ids[149] as string },
      admin,
    );
    expect(unbounded).toHaveLength(100);
    await expect(
      dispatcher.dispatch("events.replay", { beforeId: "evt_gone", limit: 2 }, admin),
    ).rejects.toMatchObject({ code: "HISTORY_NOT_KEPT", details: { oldestTs: T0 } });

    const empty = await pagedRig(0);
    await expect(
      empty.dispatcher.dispatch("events.replay", { beforeId: "evt_any", limit: 2 }, admin),
    ).resolves.toEqual([]);

    const failing = plainProjection("failing", () => ({
      apply: () => {
        throw new Error("projection broke");
      },
      prune: () => undefined,
    }));
    const notWriting = await pagedRig(1, { projections: [failing] });
    expect(notWriting.rig.history.status().writing).toBe(false);
    const unstarted = await buildDispatcher();
    for (const { dispatcher: target } of [notWriting, unstarted]) {
      await expect(
        target.dispatch("events.replay", { beforeId: "evt_any", limit: 2 }, admin),
      ).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });
    }
  });

  it("events.replay with limit alone returns the newest n events, oldest first, through the worker dispatcher", async () => {
    const { dispatcher } = await pagedRig(5);
    const page = await dispatcher.dispatch("events.replay", { limit: 2 }, admin);
    expect(reasons(page)).toEqual(["r4", "r5"]);
  });
});

describe("Dispatcher: nuke.run", () => {
  it("rejects an agent session with FORBIDDEN, without deleting anything", async () => {
    const { dispatcher, registry } = await buildDispatcher({ includeNuke: true });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    await expect(
      dispatcher.dispatch("nuke.run", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("admin can run it, releasing every lease and reporting the deleteDevices flag it ran with", async () => {
    const { dispatcher, registry } = await buildDispatcher({ includeNuke: true });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    expect(registry.snapshot.leases).toHaveLength(1);

    const result = await dispatcher.dispatch(
      "nuke.run",
      { deleteDevices: false },
      session({ role: "admin" }),
    );

    expect(result.releasedLeaseIds).toHaveLength(1);
    expect(registry.snapshot.leases).toHaveLength(0);
  });

  it("throws NukeUnavailableError when the dispatcher was built with no Nuke wired -- an admin cannot bypass this", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("nuke.run", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ name: "NukeUnavailableError" });
  });
});

describe("Dispatcher: warm.forget", () => {
  it("hands the match to the warm pool and answers each kind it forgot with its mode, full when unset, its image tag and its baseline; an agent is FORBIDDEN and nothing is forgotten", async () => {
    const matches: unknown[] = [];
    const { dispatcher } = await buildDispatcher({
      warmKinds: {
        forget: (match) => {
          matches.push(match);
          return [
            { model: "Pixel", osVersion: "36", physical: false, platform: "android" },
            {
              imageTag: "google_apis",
              mode: "slim",
              model: "Pixel",
              osVersion: "35",
              physical: false,
              platform: "android",
            },
            {
              baseline: { name: "checkout", version: 3 },
              model: "Pixel",
              osVersion: "36",
              physical: false,
              platform: "android",
            },
          ];
        },
      },
    });

    await expect(
      dispatcher.dispatch(
        "warm.forget",
        { model: "Pixel", platform: "android" },
        session({ role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(matches).toEqual([]);

    expect(
      await dispatcher.dispatch(
        "warm.forget",
        { model: "Pixel", platform: "android" },
        session({ role: "admin" }),
      ),
    ).toEqual({
      forgotten: [
        { mode: "full", model: "Pixel", osVersion: "36", platform: "android" },
        {
          imageTag: "google_apis",
          mode: "slim",
          model: "Pixel",
          osVersion: "35",
          platform: "android",
        },
        {
          baseline: "checkout",
          mode: "full",
          model: "Pixel",
          osVersion: "36",
          platform: "android",
        },
      ],
    });
    expect(matches).toEqual([{ model: "Pixel", platform: "android" }]);
  });

  it("answers INTERNAL with no warm pool wired", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "warm.forget",
        { model: "Pixel", platform: "android" },
        session({ role: "admin" }),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL", message: "The warm pool is unavailable" });
  });
});

describe("Dispatcher: #parseOutput", () => {
  it("fails closed with an opaque Internal error when a handler's output violates its contract schema, instead of leaking the malformed payload", async () => {
    const badCatalog: CatalogReader = {
      listCatalog: async () => [{ notAValidCatalogEntry: true } as never],
    };
    const { dispatcher } = await buildDispatcher({ catalog: badCatalog });

    const error = await dispatcher.dispatch("catalog.get", {}, session()).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    // why: fails closed, generically -- not the raw zod issues (which could describe internal
    // shape) and not the malformed payload itself.
    expect(classifyError(error) ?? "INTERNAL").toBe("INTERNAL");
    expect((error as Error).message).toMatch(/does not match its contract output schema/);
    expect(String(error)).not.toContain("notAValidCatalogEntry");
  });
});

describe("Dispatcher: error codes", () => {
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

describe("Dispatcher: lease.request naming a baseline", () => {
  it("gives a copy of the baseline, and the grant, lease.granted and device.provisioned carry its name and version, and lease.requested, lease.rejected and lease.declined the name the request gave", async () => {
    const { dispatcher, driver, eventBus, registry } = await buildDispatcher({
      capacity: {
        config: {
          limits: {
            android: { maxDevices: 1, maxRunning: 1 },
            ios: { maxDevices: 1, maxRunning: 1 },
            maxRunning: 3,
          },
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
        },
        strategy: "resource",
      },
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
    });
    const first = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === first.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/login.txt", "signed in");
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: first.lease.id, name: "checkout" },
      session({ role: "admin" }),
    );

    const grant = await dispatcher.dispatch(
      "lease.request",
      { baseline: "checkout", platform: "ios" },
      session(),
    );

    expect(grant.device.spec).toEqual({
      baseline: { name: "checkout", version: 1 },
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      physical: false,
      platform: "ios",
    });
    expect(grant.device.id).not.toBe(first.device.id);
    const copy = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    expect(driver.deviceFile(copy?.driverDeviceId ?? "", "data/login.txt")).toBe("signed in");
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "lease.granted")
        .map((envelope) => envelope.payload)
        .at(-1),
    ).toMatchObject({ baseline: { name: "checkout", version: 1 }, deviceId: grant.device.id });

    const full = { baseline: "checkout", noWait: true, platform: "ios" } as const;
    await expect(
      dispatcher.dispatch("lease.request", { ...full, requesterId: "agent-2" }, session()),
    ).rejects.toMatchObject({
      code: "NO_CAPACITY",
    });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...full, fleetRequestId: "req_gw1" },
        session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
      ),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    const specOf = (event: string, field: "requestSpec" | "spec") =>
      eventBus
        .replay()
        .filter((envelope) => envelope.event === event)
        .map((envelope) => (envelope.payload as Record<string, { baseline?: unknown }>)[field])
        .map((spec) => spec?.baseline)
        .filter((baseline) => baseline !== undefined);
    expect({
      declined: specOf("lease.declined", "requestSpec"),
      provisioned: specOf("device.provisioned", "spec"),
      rejected: specOf("lease.rejected", "requestSpec"),
      requested: specOf("lease.requested", "requestSpec"),
    }).toEqual({
      declined: ["checkout"],
      provisioned: [{ name: "checkout", version: 1 }],
      rejected: ["checkout"],
      requested: ["checkout", "checkout", "checkout"],
    });

    let leaseId = grant.lease.id;
    for (const matching of [{ model: "iphone 17 pro" }, { osVersion: ">=26" }]) {
      await dispatcher.dispatch("lease.release", { leaseId }, session());
      const again = await dispatcher.dispatch(
        "lease.request",
        { baseline: "checkout", platform: "ios", ...matching },
        session(),
      );
      expect(again.device.spec.baseline).toEqual({ name: "checkout", version: 1 });
      leaseId = again.lease.id;
    }
  });
});

describe("Dispatcher: lease.request naming a baseline that cannot serve it", () => {
  it("fails at once, provisioning nothing, as UNKNOWN_BASELINE, BASELINE_MISMATCH naming the first differing field, BASELINE_STALE or BAD_REQUEST", async () => {
    const clock = new FakeClock(1_000);
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const { dispatcher, driver, registry } = await buildDispatcher({
      clock,
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
      extraDrivers: [android],
    });
    const admin = session({ role: "admin" });
    const first = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: first.lease.id, name: "checkout" },
      admin,
    );
    const provisions = (): number =>
      driver.calls.filter((call) => call.operation === "provision").length;
    const failure = async (input: Record<string, unknown>) => {
      const error = await dispatcher
        .dispatch("lease.request", input as never, session())
        .catch((caught: unknown) => caught);
      return error instanceof Error
        ? {
            code: classifyError(error),
            details: (error as DispatchError).details,
            message: error.message,
          }
        : error;
    };
    const named = { baseline: "checkout", platform: "ios" };

    const control = await dispatcher.dispatch(
      "lease.request",
      { ...named, mode: "full", model: "iPhone 17 Pro", osVersion: "26.5" } as never,
      session(),
    );
    expect(control.device.spec.baseline).toEqual({ name: "checkout", version: 1 });
    await dispatcher.dispatch("lease.release", { leaseId: control.lease.id }, session());
    const provisioned = provisions();

    const mismatch = (field: string, message: string) => ({
      code: "BASELINE_MISMATCH",
      details: { baseline: "checkout", field },
      message,
    });
    const failures = [];
    for (const input of [
      { ...named, baseline: "chekout" },
      { ...named, platform: "android" },
      { ...named, model: "iPhone 16" },
      { ...named, osVersion: "25.0" },
      { ...named, mode: "slim" },
      { ...named, imageTag: "google_apis" },
      { ...named, mode: "slim", osVersion: "25.0" },
      { ...named, imageTag: "google_apis", mode: "slim" },
    ]) {
      failures.push(await failure(input));
    }
    expect(failures).toEqual([
      {
        code: "UNKNOWN_BASELINE",
        details: { name: "chekout" },
        message: 'no baseline named "chekout" on this worker',
      },
      mismatch("platform", "baseline checkout is ios, the request asks for android"),
      mismatch("model", "baseline checkout is iPhone 17 Pro, the request asks for iPhone 16"),
      mismatch("osVersion", "baseline checkout is iOS 26.5, the request asks for 25.0"),
      mismatch("mode", "baseline checkout is full, the request asks for slim"),
      mismatch("imageTag", "baseline checkout is image tag none, the request asks for google_apis"),
      mismatch("osVersion", "baseline checkout is iOS 26.5, the request asks for 25.0"),
      mismatch("mode", "baseline checkout is full, the request asks for slim"),
    ]);

    const [source] = await driver.listSources();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    driver.setSources([{ ...(source as NonNullable<typeof source>), staleReason: reason }]);
    await dispatcher.dispatch("baseline.list", {}, admin);
    expect(await failure(named)).toEqual({
      code: "BASELINE_STALE",
      details: { baseline: "checkout", reason },
      message: `baseline checkout is stale: ${reason}`,
    });
    expect(provisions()).toBe(provisioned);
    expect(registry.snapshot.devices.filter((device) => device.state !== "deleted")).toEqual([]);

    expect(await failure({ ...named, physical: true })).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("`baseline` has no meaning for a physical device"),
    });
    expect(await failure({ ...named, class: "tablet" })).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "a request names a baseline or a class, not both: send only one of `baseline` and `class`",
      ),
    });
  });
});

describe("Dispatcher: a baseline lease is released", () => {
  it.each([
    { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
    { platform: "android", model: "Pixel 8", osVersion: "36" },
  ] as const)(
    "the next lease naming the baseline gets a new copy with none of the previous lease's changes ($platform)",
    async ({ model, osVersion, platform }) => {
      const clock = new FakeClock(1_000);
      const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
      const { dispatcher, driver, registry } = await buildDispatcher({
        clock,
        driverOptions: { knownModels: ["iPhone 17 Pro"] },
        extraDrivers: [android],
      });
      const device = platform === "ios" ? driver : android;
      const fileOf = (deviceId: string, path: string): string | undefined =>
        device.deviceFile(
          registry.snapshot.virtualDevices.find((candidate) => candidate.id === deviceId)
            ?.driverDeviceId ?? "",
          path,
        );
      const operator = await dispatcher.dispatch(
        "lease.request",
        { model, osVersion, platform },
        session(),
      );
      const prepared = registry.snapshot.virtualDevices.find(
        (candidate) => candidate.id === operator.device.id,
      );
      device.writeDeviceFile(prepared?.driverDeviceId ?? "", "data/login.txt", "signed in");
      await dispatcher.dispatch(
        "baseline.save",
        { leaseId: operator.lease.id, name: "checkout" },
        session({ role: "admin" }),
      );

      const first = await dispatcher.dispatch(
        "lease.request",
        { baseline: "checkout", platform },
        session(),
      );
      expect(fileOf(first.device.id, "data/login.txt")).toBe("signed in");
      device.writeDeviceFile(
        registry.snapshot.virtualDevices.find((candidate) => candidate.id === first.device.id)
          ?.driverDeviceId ?? "",
        "data/session.txt",
        "left behind",
      );
      await dispatcher.dispatch("lease.release", { leaseId: first.lease.id }, session());
      const second = await dispatcher.dispatch(
        "lease.request",
        { baseline: "checkout", platform },
        session(),
      );

      expect(second.device.id).not.toBe(first.device.id);
      expect(second.device.spec.baseline).toEqual({ name: "checkout", version: 1 });
      expect(fileOf(second.device.id, "data/login.txt")).toBe("signed in");
      expect(fileOf(second.device.id, "data/session.txt")).toBeUndefined();
    },
  );
});

// why: an idle copy of version 1 is what a warm pool leaves behind; the registry is written as the pool's provisioner would.
async function seedIdleCopy(
  driver: FakeDriver,
  registry: Awaited<ReturnType<typeof buildDispatcher>>["registry"],
  model: string,
): Promise<{ readonly id: string }> {
  const [source] = await driver.listSources();
  const spec = {
    baseline: { name: "checkout", version: 1 },
    model,
    osVersion: "26.5",
    physical: false,
    platform: "ios",
  } as const;
  const driverDevice = await driver.provision(spec, { source: source?.id ?? "" });
  const booted = await driver.makeReady(driverDevice, { mode: "full", purpose: "prepare" });
  const registered = await registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  return registry.transitionDevice(
    registered.id,
    "ready",
    { event: "device.ready", payload: { bootDuration: 0, deviceId: registered.id } },
    booted.mode === undefined ? undefined : { mode: booted.mode },
  );
}

type ReplaceScenario = "running" | "idle" | "waiting" | "making";

const replaceModel = "iPhone 17 Pro";

async function buildReplaceHarness(scenario: ReplaceScenario) {
  const clock = new FakeClock(1_000);
  const oneDevice = {
    config: {
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 3,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
    strategy: "resource",
  } as const;
  const built = await buildDispatcher({
    ...(scenario === "waiting" ? { capacity: oneDevice } : {}),
    clock,
    driverOptions: {
      knownModels: [replaceModel],
      ...(scenario === "making" ? { latencyMs: { provision: 5_000 } } : {}),
    },
  });
  const { dispatcher, driver, engine, eventBus, registry, state } = built;
  const settle = async <Result>(pending: Promise<Result>, step = 5_000): Promise<Result> => {
    let done = false;
    void pending.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      clock.advance(step);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return pending;
  };
  const lease = (input: Record<string, unknown>) =>
    settle(dispatcher.dispatch("lease.request", { platform: "ios", ...input } as never, session()));
  const driverIdOf = (deviceId: string): string =>
    registry.snapshot.virtualDevices.find((device) => device.id === deviceId)?.driverDeviceId ?? "";
  const saveCheckout = (leaseId: string, step?: number) =>
    settle(
      dispatcher.dispatch(
        "baseline.save",
        { leaseId, name: "checkout" },
        session({ role: "admin" }),
      ),
      step,
    );
  return {
    clock,
    dispatcher,
    driver,
    engine,
    fileOf: (deviceId: string) => driver.deviceFile(driverIdOf(deviceId), "data/version.txt"),
    lease,
    registry,
    copiesOf: (version: number): number =>
      registry.snapshot.virtualDevices.filter((device) => device.spec.baseline?.version === version)
        .length,
    removed: () =>
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "baseline.removed")
        .map((envelope) => envelope.payload),
    saveCheckout,
    saveFrom: async (requesterId: string, marker: string): Promise<void> => {
      const held = await lease({ model: replaceModel, requesterId });
      driver.writeDeviceFile(driverIdOf(held.device.id), "data/version.txt", marker);
      await saveCheckout(held.lease.id);
    },
    settle,
    stateOf: (deviceId: string): string | undefined =>
      registry.snapshot.virtualDevices.find((device) => device.id === deviceId)?.state,
    versions: (): number[] =>
      state.database
        .prepare("SELECT version FROM baselines WHERE name = 'checkout' ORDER BY version")
        .all()
        .map((row) => Number(row.version)),
    writeFile: (deviceId: string, marker: string) =>
      driver.writeDeviceFile(driverIdOf(deviceId), "data/version.txt", marker),
  };
}

type ReplaceHarness = Awaited<ReturnType<typeof buildReplaceHarness>>;

/** why: the v1 baseline exists; the scenario's lease, idle copy or waiting request is arranged around the operator's lease. */
async function arrangeReplace(harness: ReplaceHarness, scenario: ReplaceScenario) {
  await harness.saveFrom("operator", "one");
  expect(harness.versions()).toEqual([1]);
  const running =
    scenario === "running"
      ? await harness.lease({ baseline: "checkout", requesterId: "agent-1" })
      : undefined;
  const idle =
    scenario === "idle"
      ? await seedIdleCopy(harness.driver, harness.registry, replaceModel)
      : undefined;
  const operator = await harness.lease({ model: replaceModel, requesterId: "operator" });
  const waiting =
    scenario === "waiting" || scenario === "making"
      ? harness.dispatcher.dispatch(
          "lease.request",
          { baseline: "checkout", platform: "ios", requesterId: "agent-2" },
          session(),
        )
      : undefined;
  for (let turn = 0; waiting !== undefined && turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { idle, operator, running, waiting };
}

describe("Dispatcher: an operator replaces a baseline", () => {
  it.each([
    { label: "a lease is running", case: "running", oldCopies: 1 },
    { label: "no lease is running", case: "idle", oldCopies: 1 },
    {
      label: "the running lease's delete fails at its release",
      case: "running",
      oldCopies: 1,
      failDelete: true,
    },
    { label: "a request is waiting", case: "waiting", oldCopies: 0 },
    { label: "a copy is being made", case: "making", oldCopies: 1 },
  ] as const)(
    "running leases keep their device, the next lease gets the new version, a waiting request too, idle old-version devices are destroyed, a copy of the old version finished after the save is deleted and never granted, and the old version goes with its last device ($label)",
    async ({ case: scenario, oldCopies, ...rest }) => {
      const failDelete = "failDelete" in rest;
      const harness = await buildReplaceHarness(scenario);
      const { idle, operator, running, waiting } = await arrangeReplace(harness, scenario);
      harness.writeFile(operator.device.id, "two");
      // why: the first save in the arrangement and this lease's own save destroy a device before the idle copy.
      if (failDelete) harness.driver.failOn("destroy", 3, new Error("destroy failed"));

      await harness.saveCheckout(operator.lease.id, 100);
      if (running !== undefined) {
        expect(harness.stateOf(running.device.id)).toBe("leased");
        expect(harness.versions()).toEqual([1, 2]);
        expect(harness.removed()).toEqual([]);
      }
      if (idle !== undefined) expect(harness.stateOf(idle.id)).toBe("deleted");
      const next = await (waiting === undefined
        ? harness.lease({ baseline: "checkout", requesterId: "agent-3" })
        : harness.settle(waiting));
      expect(next.device.spec.baseline).toEqual({ name: "checkout", version: 2 });
      expect(harness.fileOf(next.device.id)).toBe("two");
      expect(harness.copiesOf(1)).toBe(oldCopies);
      if (running !== undefined) {
        await harness.dispatcher.dispatch(
          "lease.release",
          { leaseId: running.lease.id },
          session(),
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (failDelete && running !== undefined) {
        // why: the last device of version 1 leaves through the quarantine's delete retry, and that drops the version.
        expect(harness.stateOf(running.device.id)).toBe("quarantined");
        expect(harness.versions()).toEqual([1, 2]);
        harness.clock.advance(60 * 60_000);
        for (let turn = 0; turn < 10; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(harness.stateOf(running.device.id)).toBe("deleted");
      }
      expect(harness.versions()).toEqual([2]);
      expect(harness.removed()).toEqual([
        expect.objectContaining({ name: "checkout", reason: "replaced", version: 1 }),
      ]);
      expect(await harness.driver.listSources()).toHaveLength(1);
    },
  );
});

describe("Dispatcher: an operator replaces a baseline while an idle old copy will not delete", () => {
  it("the save succeeds, the idle old-version device stays shut down, and version 1 stays with it", async () => {
    const harness = await buildReplaceHarness("idle");
    const { idle, operator } = await arrangeReplace(harness, "idle");
    harness.writeFile(operator.device.id, "two");
    // why: the first save in the arrangement and this lease's own save destroy a device before the idle copy.
    harness.driver.failOn("destroy", 3, new Error("destroy failed"));

    await harness.saveCheckout(operator.lease.id, 100);

    if (idle === undefined) throw new Error("the arrangement left no idle device");
    expect(harness.stateOf(idle.id)).toBe("shutdown");
    expect(harness.versions()).toEqual([1, 2]);
    expect(harness.removed()).toEqual([]);
    const next = await harness.lease({ baseline: "checkout", requesterId: "agent-3" });
    expect(next.device.spec.baseline).toEqual({ name: "checkout", version: 2 });
  });
});

describe("Dispatcher: two copies of one baseline version are made at once", () => {
  it("keeps the old version after a replace until the second copy is registered, though the first copy is gone", async () => {
    const harness = await buildReplaceHarness("making");
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 10; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
    };
    await harness.saveFrom("operator", "one");
    const operator = await harness.lease({ model: replaceModel, requesterId: "operator" });
    harness.writeFile(operator.device.id, "two");
    // why: a warm pool pass makes copies without a request, so two can be in flight for one version.
    const copy = () =>
      harness.engine.core.provisioner.provision(
        {
          baseline: { name: "checkout", version: 1 },
          model: replaceModel,
          osVersion: "26.5",
          physical: false,
          platform: "ios",
        },
        { reservation: { release: () => undefined } },
      );

    const first = copy();
    await flush();
    harness.clock.advance(2_000);
    const second = copy();
    await flush();
    await harness.saveCheckout(operator.lease.id, 100);
    expect(harness.versions()).toEqual([1, 2]);

    harness.clock.advance(2_900);
    const firstCopy = await first;
    const lifecycle = harness.engine.core.deviceLifecycle;
    firstCopy.claim.release();
    const stopped = await lifecycle.shutdown(firstCopy.device, "lease-engine", "cleanup");
    await lifecycle.destroy(stopped as NonNullable<typeof stopped>, "lease-engine", "cleanup");
    await flush();
    expect(harness.stateOf(firstCopy.device.id)).toBe("deleted");
    expect(harness.versions()).toEqual([1, 2]);
    expect(harness.removed()).toEqual([]);

    harness.clock.advance(2_000);
    const secondCopy = await second;
    expect(harness.stateOf(secondCopy.device.id)).toBe("ready");
    expect(harness.versions()).toEqual([1, 2]);
  });
});

describe("Dispatcher: usage.get", () => {
  afterEach(removeUsageRigs);

  const admin = session({ role: "admin" });

  async function historyWithRows(options: { readonly gatewayLabel?: string } = {}) {
    const rig = await usageRig();
    rig.emit("lease.requested", requested("R1"));
    const gate = { open: true };
    const eventHistory = {
      replay: (input?: { readonly sinceTs?: number }) => rig.history.replay(input),
      replayPage: (input: { readonly beforeId?: string; readonly limit: number }) =>
        rig.history.replayPage(input),
      status: () => ({ ...rig.history.status(), opened: gate.open && rig.history.status().opened }),
    };
    return { eventHistory, gate, rig, ...options };
  }

  it("the worker handler answers HISTORY_NOT_KEPT with oldestTs and the message naming when the figures start when to is 1 ms before the oldest row, and figures when to is that row's time", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });

    await expect(
      dispatcher.dispatch("usage.get", { from: T0 - 2 * HOUR, to: T0 - 1 }, admin),
    ).rejects.toMatchObject({
      code: "HISTORY_NOT_KEPT",
      details: { oldestTs: T0 },
      message: `The history does not reach back to the end of that window; its figures start at ${new Date(T0).toISOString()}.`,
    });
    await expect(
      dispatcher.dispatch("usage.get", { from: T0 - 2 * HOUR, to: T0 }, admin),
    ).resolves.toMatchObject({ window: { to: T0 } });
  });

  it("the worker handler answers HISTORY_UNAVAILABLE with the message naming daemon.log while history.status().opened is false, after answering figures while it was true", async () => {
    const { eventHistory, gate, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };

    await expect(dispatcher.dispatch("usage.get", window, admin)).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    gate.open = false;
    const before = threads.posts.length;

    await expect(dispatcher.dispatch("usage.get", window, admin)).rejects.toMatchObject({
      code: "HISTORY_UNAVAILABLE",
      message: "The history could not be opened, so no figures can be read; see daemon.log.",
    });
    expect(threads.posts).toHaveLength(before);
  });

  it("the worker handler passes includeLedger to the reader: it lists the window's requests when true, leaves requests out when absent or false, and refuses a non-boolean as BAD_REQUEST", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };

    const listed = await dispatcher.dispatch(
      "usage.get",
      { ...window, includeLedger: true },
      admin,
    );
    const absent = await dispatcher.dispatch("usage.get", window, admin);
    const off = await dispatcher.dispatch("usage.get", { ...window, includeLedger: false }, admin);

    expect(listed.requests?.map((entry) => entry.requestId)).toEqual(["R1"]);
    expect(absent).not.toHaveProperty("requests");
    expect(off).not.toHaveProperty("requests");
    await expect(
      dispatcher.dispatch("usage.get", { ...window, includeLedger: "yes" } as never, admin),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the worker handler answers one worker entry, itself, with its instance id and gateway.label, or no label when none is set", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const labelled = await buildDispatcher({
      eventHistory,
      gatewayLabel: "lab-a",
      historyPath: rig.historyPath,
    });
    const plain = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };

    const named = await labelled.dispatcher.dispatch("usage.get", window, admin);
    const anonymous = await plain.dispatcher.dispatch("usage.get", window, admin);

    expect(named.workers).toMatchObject([{ id: "instance-1", label: "lab-a", requests: 1 }]);
    expect(anonymous.workers).toHaveLength(1);
    expect(anonymous.workers[0]).toMatchObject({ id: "instance-1", requests: 1 });
    expect(anonymous.workers[0]).not.toHaveProperty("label");
  });

  it("the worker handler labels a requester from the token store, and leaves the label out when the daemon has no token store", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const withStore = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const withoutStore = await buildDispatcher({
      eventHistory,
      historyPath: rig.historyPath,
      withoutTokens: true,
    });
    const { record } = await withStore.tokens.create("agent", "ci-bot");
    rig.emit("lease.requested", requested("R2", { requester: record.id }));
    const window = { from: T0, to: T0 + HOUR };

    const labelled = await withStore.dispatcher.dispatch("usage.get", window, admin);
    const unlabelled = await withoutStore.dispatcher.dispatch("usage.get", window, admin);

    expect(labelled.requesters).toEqual([
      { granted: 0, heldTotalMs: 0, id: "alice", rejected: 0, requests: 1 },
      { granted: 0, heldTotalMs: 0, id: record.id, label: "ci-bot", rejected: 0, requests: 1 },
    ]);
    expect(unlabelled.requesters.map((entry) => entry.id)).toEqual(["alice", record.id]);
    expect(unlabelled.requesters.every((entry) => !("label" in entry))).toBe(true);
  });

  it("usage.get runs two calls for one window as one read on the read thread and gives both its answer, and two windows as two reads", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const call = (from: number, to = from + HOUR) =>
      dispatcher.dispatch("usage.get", { from, to }, admin);
    const readsOf = async (run: () => Promise<unknown>) => {
      const before = threads.posts.length;
      await run();
      return threads.posts.length - before;
    };
    await call(T0);
    const single = await readsOf(() => call(T0));

    const [first, second] = await Promise.all([call(T0), call(T0)]);
    const sameWindow = await readsOf(() => Promise.all([call(T0), call(T0)]));
    const twoWindows = await readsOf(() => Promise.all([call(T0), call(T0 - HOUR)]));
    const otherStart = await readsOf(() => Promise.all([call(T0), call(T0 - HOUR, T0 + HOUR)]));
    const otherEnd = await readsOf(() => Promise.all([call(T0), call(T0, T0 + 2 * HOUR)]));

    expect(single).toBeGreaterThan(0);
    expect(sameWindow).toBe(single);
    expect(twoWindows).toBe(2 * single);
    expect(otherStart).toBe(2 * single);
    expect(otherEnd).toBe(2 * single);
    expect(first).toEqual(second);
    expect(first.totals.requests).toBe(1);
  });

  it("dispose ends the read thread", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    await dispatcher.dispatch("usage.get", { from: T0, to: T0 + HOUR }, admin);
    const thread = threads.workers.at(-1) as unknown as import("node:worker_threads").Worker;
    let exited = false;
    thread.on("exit", () => {
      exited = true;
    });

    dispatcher.dispose();

    await vi.waitFor(() => expect(exited).toBe(true));
  });

  it("usage.get answers INTERNAL to a call in flight when the read thread exits, and answers the next call from a new thread", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };
    await expect(dispatcher.dispatch("usage.get", window, admin)).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    const started = threads.workers.length;
    threads.crashOnPost = true;

    try {
      await expect(dispatcher.dispatch("usage.get", window, admin)).rejects.toMatchObject({
        code: "INTERNAL",
      });
    } finally {
      threads.crashOnPost = false;
    }

    await expect(dispatcher.dispatch("usage.get", window, admin)).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    expect(threads.workers.length).toBe(started + 1);
  });
});
