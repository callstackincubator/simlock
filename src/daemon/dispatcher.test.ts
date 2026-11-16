import { describe, expect, it, vi } from "vitest";
import { type CatalogReader } from "../core/index.js";
import {
  OPERATIONS,
  statusDeviceSchema,
  WORKER_VIEW_CATALOG_EVENTS,
  WORKER_VIEW_REFRESH_INTERVAL_MS,
} from "../contract/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "../core/testing.js";
import { DispatchError } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import { HOST_SYSTEM, buildDispatcher, flushPromises, session } from "./test-dispatcher.js";

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

  it("catalog.get names android.defaultImageTag on the Android entry only, and nothing when it is unset", async () => {
    const android = () =>
      new FakeDriver({ availableOsVersions: ["36"], clock: new FakeClock(0), platform: "android" });
    const set = await buildDispatcher({
      androidDefaultImageTag: "google_apis_playstore",
      extraDrivers: [android()],
    });
    const unset = await buildDispatcher({ extraDrivers: [android()] });

    const withTag = (await set.dispatcher.dispatch("catalog.get", {}, admin)).platforms;
    const without = (await unset.dispatcher.dispatch("catalog.get", {}, admin)).platforms;

    expect(withTag.map((entry) => entry.platform).sort()).toEqual(["android", "ios"]);
    expect(withTag.find((entry) => entry.platform === "android")?.defaultImageTag).toBe(
      "google_apis_playstore",
    );
    expect(withTag.find((entry) => entry.platform === "ios")).not.toHaveProperty("defaultImageTag");
    expect(without.find((entry) => entry.platform === "android")).not.toHaveProperty(
      "defaultImageTag",
    );
    const output = (tag: string) => ({
      platforms: withTag.map((entry) =>
        entry.platform === "android" ? { ...entry, defaultImageTag: tag } : entry,
      ),
    });
    expect(() => OPERATIONS["catalog.get"].output.parse(output("google_apis"))).not.toThrow();
    expect(() => OPERATIONS["catalog.get"].output.parse(output("not a tag!"))).toThrow();
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

  it("config.get carries android.defaultImageTag when set and leaves it out when not", async () => {
    const withTag = await buildDispatcher({ androidDefaultImageTag: "google_apis_playstore" });
    const without = await buildDispatcher({});

    const set = await withTag.dispatcher.dispatch("config.get", {}, admin);
    const unset = await without.dispatcher.dispatch("config.get", {}, admin);

    expect(set.android["defaultImageTag"]).toBe("google_apis_playstore");
    expect(unset.android).not.toHaveProperty("defaultImageTag");
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
