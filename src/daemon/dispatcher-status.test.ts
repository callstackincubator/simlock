import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import { fixedEventHistory } from "../history/testing.js";
import {
  ComponentInstaller,
  DiskSpaceGuard,
  DriverCatalog,
  HostFactsReader,
  SerializedDecision,
} from "../core/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import type { DispatcherOptions } from "./dispatcher.js";
import { Dispatcher } from "./dispatcher.js";
import {
  HOST_SYSTEM,
  buildDispatcher,
  flushPromises,
  gibibyte,
  session,
} from "./test-dispatcher.js";

describe("Dispatcher: status.get history", () => {
  it.each([
    {
      health: "running" as const,
      history: { opened: true, setAsideAt: 1_760_605_920_000, writing: false },
    },
    { health: "starting" as const, history: { opened: false, writing: false } },
    { health: "running" as const, history: { opened: true, writing: true } },
    {
      health: "running" as const,
      history: { opened: true, rebuiltAt: 1_760_605_920_000, writing: true },
    },
    {
      health: "running" as const,
      history: { opened: true, rebuildFailed: true as const, writing: true },
    },
  ])(
    "status.get carries the history's opened, writing, setAsideAt, rebuiltAt and rebuildFailed, in the starting answer too ($health, $history)",
    async ({ health, history }) => {
      const { dispatcher } = await buildDispatcher({
        eventHistory: fixedEventHistory(history),
        health,
      });

      const status = await dispatcher.dispatch("status.get", {}, session());

      expect((status as { history?: unknown }).history).toStrictEqual(history);
    },
  );
});

describe("Dispatcher: status.get installs in progress", () => {
  const installTimeoutMs = 60_000;

  async function withInstaller() {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const installer = new ComponentInstaller({
      clock,
      decisions: new SerializedDecision(),
      diskSpace: new DiskSpaceGuard(),
      drivers: new DriverCatalog([driver]),
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      registry: {
        deleteComponent: () => Promise.resolve(),
        recordComponent: () => Promise.resolve(),
        snapshot: { components: [], devices: [], leases: [], virtualDevices: [] },
      },
      timeoutMs: installTimeoutMs,
    });
    const { dispatcher } = await buildDispatcher({ clock, components: installer });
    const installs = async () => (await dispatcher.dispatch("status.get", {}, session())).installs;
    return { clock, driver, installer, installs };
  }

  it("lists a running install as downloading and one behind it on the same platform as waiting", async () => {
    const { clock, installer, installs } = await withInstaller();

    void installer.install({ component: "27.0", platform: "ios" });
    await flushPromises();
    clock.advance(2_000);
    void installer.install({ component: "28.0", platform: "ios" });
    await flushPromises();

    expect(await installs()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 1 },
      { component: "28.0", platform: "ios", since: 3_000, state: "waiting", waiters: 1 },
    ]);
  });

  it("lists an install three calls joined once, with waiters: 3", async () => {
    const { installer, installs } = await withInstaller();

    for (let call = 0; call < 3; call += 1) {
      void installer.install({ component: "27.0", platform: "ios" });
    }
    await flushPromises();

    expect(await installs()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 3 },
    ]);
  });

  it("lists no install once it has succeeded", async () => {
    const { driver, installer, installs } = await withInstaller();
    const call = installer.install({ component: "27.0", platform: "ios" });
    await flushPromises();
    expect(await installs()).toHaveLength(1);

    driver.releaseInstalls();
    await call;

    expect(await installs()).toEqual([]);
  });

  it("lists no install once it has failed", async () => {
    const { driver, installer, installs } = await withInstaller();
    // why: the first install is held; the second waits behind it and fails once its turn comes.
    const first = installer.install({ component: "27.0", platform: "ios" });
    const call = installer.install({ component: "28.0", platform: "ios" });
    await flushPromises();
    expect(await installs()).toHaveLength(2);

    driver.failOn("installComponent", 2, new Error("installer exited 1"));
    driver.releaseInstalls();

    await first;
    await expect(call).rejects.toThrow("installer exited 1");
    expect(await installs()).toEqual([]);
  });

  it("lists no install once it has timed out, running or still waiting", async () => {
    const { clock, installer, installs } = await withInstaller();
    const running = installer.install({ component: "27.0", platform: "ios" });
    const waiting = installer.install({ component: "28.0", platform: "ios" });
    await flushPromises();
    expect(await installs()).toHaveLength(2);

    clock.advance(installTimeoutMs);
    await expect(running).rejects.toMatchObject({ name: "ComponentInstallTimeoutError" });
    await expect(waiting).rejects.toMatchObject({ name: "ComponentInstallTimeoutError" });

    expect(await installs()).toEqual([]);
  });

  it("answers an empty list when nothing is installing", async () => {
    const { installs } = await withInstaller();

    expect(await installs()).toEqual([]);
  });
});

describe("Dispatcher: list.get requests and status.get waiting", () => {
  const IOS_REQUEST = {
    model: "iPhone 17 Pro",
    osVersion: "26.5",
    platform: "ios",
  } as const;

  function request(
    dispatcher: Dispatcher,
    requesterId: string,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    return dispatcher.dispatch(
      "lease.request",
      { ...IOS_REQUEST, requesterId, ...extra },
      session({ principal: "host" }),
    );
  }

  async function fillIos(dispatcher: Dispatcher): Promise<void> {
    await request(dispatcher, "holder-1");
    await request(dispatcher, "holder-2");
  }

  const requests = (dispatcher: Dispatcher) =>
    dispatcher.dispatch("list.get", { kind: "requests" }, session({ role: "admin" }));

  it("inbox.get on a worker answers a lease about to end and a request that has waited over 60 s, naming a holder by its token's label, or by its id when the daemon has no token store", async () => {
    const holders = async (withoutTokens: boolean) => {
      const { clock, dispatcher, engine, tokens } = await buildDispatcher({ withoutTokens });
      const { record } = await tokens.create("agent", "ci-bot");
      await request(dispatcher, record.id, { ttlMs: 250_000 });
      await request(dispatcher, "holder-2");
      void request(dispatcher, "agent-a");
      await expect.poll(() => engine.queueDepth).toBe(1);
      clock.advance(60_001);
      const { items } = await dispatcher.dispatch("inbox.get", {}, session({ role: "admin" }));
      return { id: record.id, items };
    };

    const labelled = await holders(false);
    const bare = await holders(true);

    expect(
      labelled.items.map((item) => [item.key.replace(/\/[^/]+\//, "/id/"), item.condition]),
    ).toEqual([
      ["request/id/waiting", "waiting"],
      ["lease/id/ending", "ending"],
    ]);
    expect(labelled.items).toContainEqual(
      expect.objectContaining({
        lease: expect.objectContaining({ holder: "ci-bot", model: "iPhone 17 Pro" }),
      }),
    );
    expect(bare.items).toContainEqual(
      expect.objectContaining({ lease: expect.objectContaining({ holder: bare.id }) }),
    );
  });

  it("list.get requests on a worker returns every open request with its queue position", async () => {
    const { clock, dispatcher, engine } = await buildDispatcher();
    await fillIos(dispatcher);
    const firstAt = clock.now();
    void request(dispatcher, "agent-a", { idempotencyKey: "key-a", mode: "full" });
    await expect.poll(() => engine.queueDepth).toBe(1);
    clock.advance(5_000);
    void request(dispatcher, "agent-b");
    await expect.poll(() => engine.queueDepth).toBe(2);

    const listed = await requests(dispatcher);

    expect(listed).toEqual([
      {
        createdAt: firstAt,
        id: expect.any(String),
        queuePosition: 1,
        reason: "device-limit",
        requesterId: "agent-a",
        spec: { ...IOS_REQUEST, mode: "full" },
        stage: "queued",
      },
      {
        createdAt: firstAt + 5_000,
        id: expect.any(String),
        queuePosition: 2,
        reason: "behind-earlier-request",
        requesterId: "agent-b",
        spec: IOS_REQUEST,
        stage: "queued",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("key-a");
    expect(JSON.stringify(listed)).not.toContain('"host"');
  });

  it("a request that is starting a device has stage starting and no queue position", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: { latencyMs: { provision: 60_000 } },
    });
    void request(dispatcher, "agent-a");

    await expect.poll(async () => (await requests(dispatcher)).length).toBe(1);

    expect(await requests(dispatcher)).toEqual([
      {
        createdAt: expect.any(Number),
        id: expect.any(String),
        requesterId: "agent-a",
        spec: IOS_REQUEST,
        stage: "starting",
      },
    ]);
  });

  it("a granted, failed or cancelled request is not listed", async () => {
    const { clock, dispatcher, engine, registry } = await buildDispatcher();
    await fillIos(dispatcher);
    const timedOut = request(dispatcher, "agent-timeout", { timeoutMs: 1_000 });
    const cancelled = request(dispatcher, "agent-cancel");
    await expect.poll(() => engine.queueDepth).toBe(2);
    expect(await requests(dispatcher)).toHaveLength(2);

    clock.advance(1_000);
    await expect(timedOut).rejects.toMatchObject({ name: "QueueTimeoutError" });
    await dispatcher.dispatch(
      "lease.cancel",
      { requesterId: "agent-cancel" },
      session({ principal: "host" }),
    );
    await expect(cancelled).rejects.toThrow();

    await expect
      .poll(() => registry.leaseRequests().map((record) => record.state))
      .toEqual(["granted", "granted", "failed", "cancelled"]);
    expect(await requests(dispatcher)).toEqual([]);
  });

  it("status.get waiting matches list.get requests on a worker", async () => {
    const { dispatcher, engine } = await buildDispatcher({
      driverOptions: { latencyMs: { provision: 60_000 } },
    });
    void request(dispatcher, "agent-a");
    void request(dispatcher, "agent-b");
    void request(dispatcher, "agent-c");
    await expect.poll(() => engine.queueDepth).toBe(1);

    const listed = await requests(dispatcher);
    const { waiting } = await dispatcher.dispatch("status.get", {}, session({ role: "admin" }));

    expect(listed.map((entry) => ("stage" in entry ? entry.stage : undefined))).toEqual([
      "starting",
      "starting",
      "queued",
    ]);
    expect(waiting).toEqual(listed);
  });
});

describe("Dispatcher: status.get console address", () => {
  it("status.get carries consoleUrl when HTTP is enabled and omits it when disabled", async () => {
    const enabled = await buildDispatcher({
      http: { enabled: true, host: "127.0.0.1", port: 4711 },
    });
    const disabled = await buildDispatcher({
      http: { enabled: false, host: "127.0.0.1", port: 4711 },
    });

    const on = await enabled.dispatcher.dispatch("status.get", {}, session());
    const off = await disabled.dispatcher.dispatch("status.get", {}, session());

    expect(on.daemon).toEqual({
      consoleUrl: "http://127.0.0.1:4711/",
      health: "running",
      mode: "worker",
      version: "1.2.3",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    });
    expect(off.daemon).toEqual({
      health: "running",
      mode: "worker",
      version: "1.2.3",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    });
    expect("consoleUrl" in off.daemon).toBe(false);
  });
});

describe("Dispatcher: status.get host facts", () => {
  it("reports operating system, version, architecture, and every driver's tool versions", async () => {
    const hostFacts = new HostFactsReader({
      clock: new FakeClock(0),
      drivers: [
        {
          platform: "ios",
          toolVersions: () => Promise.resolve([{ build: "16F6", name: "xcode", version: "16.4" }]),
        },
        {
          platform: "android",
          toolVersions: () => Promise.resolve([{ name: "emulator", version: "35.4.9" }]),
        },
      ],
      system: HOST_SYSTEM,
    });
    await hostFacts.refresh();
    const { dispatcher } = await buildDispatcher({ hostFacts: () => hostFacts.current() });

    const status = (await dispatcher.dispatch("status.get", {}, session())) as {
      readonly host: unknown;
    };

    expect(status.host).toEqual({
      arch: "arm64",
      os: "macOS",
      osVersion: "15.5",
      tools: [
        { build: "16F6", name: "xcode", platform: "ios", version: "16.4" },
        { name: "emulator", platform: "android", version: "35.4.9" },
      ],
    });
  });
});

describe("Dispatcher: status.get RAM budget", () => {
  const sizes = {
    androidBytesPerDevice: 4 * gibibyte,
    iosBytesPerDevice: 2 * gibibyte,
    iosSlimBytesPerDevice: 0.5 * gibibyte,
  };

  it("reports a use equal to the sum of the listed devices' sizes by reported mode, including a slim-spec device still provisioning", async () => {
    const { dispatcher, registry } = await buildDispatcher({
      capacity: {
        strategy: "resource",
        config: {
          limits: {
            android: { maxDevices: 2, maxRunning: 2 },
            ios: { maxDevices: 4, maxRunning: 4 },
            maxRunning: 6,
          },
          ramBudget: sizes,
        },
      },
      driverOptions: { slimmableOsVersions: ["26.5"] },
    });
    const ios = {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    await dispatcher.dispatch("lease.request", { ...ios, mode: "slim" }, session());
    await dispatcher.dispatch(
      "lease.request",
      { ...ios, mode: "full" },
      session({ principal: "tok_other" }),
    );
    await registry.registerDevice({
      backend: "local",
      driverData: { fakeDeviceId: "driver-provisioning" },
      driverDeviceId: "driver-provisioning",
      provisionDuration: 0,
      spec: { ...ios, mode: "slim", physical: false },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    const listed = (status.devices ?? [])
      .filter((device) => device.state !== "deleted")
      .map((device) =>
        device.mode === "slim" ? sizes.iosSlimBytesPerDevice : sizes.iosBytesPerDevice,
      );
    expect(status.devices?.map((device) => device.mode).sort()).toEqual(["full", "full", "slim"]);
    expect(status.capacity?.ramBudget).toEqual({
      limitBytes: 28 * gibibyte,
      overLimit: false,
      usedBytes: listed.reduce((total, bytes) => total + bytes, 0),
    });
    expect(status.capacity?.ramBudget?.usedBytes).toBe(4.5 * gibibyte);
  });

  describe("atRamBudget", () => {
    async function withIosDevices(count: number) {
      const built = await buildDispatcher({
        capacity: {
          strategy: "resource",
          config: {
            limits: {
              android: { maxDevices: 30, maxRunning: 30 },
              ios: { maxDevices: 30, maxRunning: 30 },
              maxRunning: 60,
            },
            ramBudget: sizes,
          },
        },
      });
      for (let index = 0; index < count; index += 1) {
        await built.registry.registerDevice({
          backend: "local",
          driverData: { fakeDeviceId: `driver-${index}` },
          driverDeviceId: `driver-${index}`,
          provisionDuration: 0,
          spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        });
      }
      return built;
    }
    const ios = {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;

    it("is true for a platform whose next full device the planner refuses for RAM, and false while it would be admitted", async () => {
      const roomy = await withIosDevices(13);
      const roomyStatus = await roomy.dispatcher.dispatch("status.get", {}, session());
      expect(roomyStatus.capacity?.ios.atRamBudget).toBe(false);
      expect(roomyStatus.capacity?.android.atRamBudget).toBe(true);
      await expect(
        roomy.dispatcher.dispatch("lease.request", { ...ios, noWait: true }, session()),
      ).resolves.toBeDefined();

      const full = await withIosDevices(14);
      const fullStatus = await full.dispatcher.dispatch("status.get", {}, session());
      expect(fullStatus.capacity?.ios.atRamBudget).toBe(true);
      await expect(
        full.dispatcher.dispatch("lease.request", { ...ios, noWait: true }, session()),
      ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    });

    it("is false under the fixed strategy, which keeps no budget", async () => {
      const { dispatcher } = await buildDispatcher({
        capacity: { strategy: "fixed", config: { maxRunning: 2 } },
      });

      const status = await dispatcher.dispatch("status.get", {}, session());

      expect(status.capacity?.ios.atRamBudget).toBe(false);
      expect(status.capacity?.android.atRamBudget).toBe(false);
    });
  });

  it("omits the RAM budget under the fixed strategy", async () => {
    const { dispatcher } = await buildDispatcher({
      capacity: { strategy: "fixed", config: { maxRunning: 2 } },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.capacity).not.toHaveProperty("ramBudget");
  });
});

describe("Dispatcher: status.get while the daemon is starting", () => {
  it("status.get on a worker whose health is starting returns daemon, history and host and no other field", async () => {
    const { dispatcher, registry } = await buildDispatcher({ health: "starting" });
    await registry.registerDevice({
      backend: "local",
      driverData: { fakeDeviceId: "driver-unchecked" },
      driverDeviceId: "driver-unchecked",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(Object.keys(status).sort()).toEqual(["daemon", "history", "host"]);
    expect(status.daemon).toEqual({
      health: "starting",
      mode: "worker",
      version: "1.2.3",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    });
    expect(status.host).toEqual({ ...HOST_SYSTEM, tools: [] });
  });

  it.each(["running", "failed"] as const)(
    "status.get on a %s daemon returns every field it returns today, and the history",
    async (health) => {
      const { dispatcher, registry } = await buildDispatcher({ health });
      await registry.registerDevice({
        backend: "local",
        driverData: { fakeDeviceId: "driver-known" },
        driverDeviceId: "driver-known",
        provisionDuration: 0,
        spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      });

      const status = await dispatcher.dispatch("status.get", {}, session());

      expect(Object.keys(status).sort()).toEqual([
        "capacity",
        "daemon",
        "devices",
        "history",
        "host",
        "installs",
        "leases",
        "physicalQueueDepth",
        "queueDepth",
        "waiting",
        "warmPool",
      ]);
      expect(status.daemon.health).toBe(health);
      expect(status.devices).toHaveLength(1);
    },
  );
});

describe("Dispatcher: status.get capabilities", () => {
  type Read = Awaited<
    ReturnType<NonNullable<DispatcherOptions["capabilitySources"]>[number]["read"]>
  >;
  const source = (read: () => Promise<Read>) => [{ name: "agent-device", read }];
  const capabilitiesAfter = async (read: () => Promise<unknown>) => {
    const { dispatcher } = await buildDispatcher({
      capabilitySources: source(read as () => Promise<Read>),
    });
    return (await dispatcher.dispatch("status.get", {}, session())).capabilities;
  };

  it("answers a reason of 600 characters with a newline, an escape, a DEL and a U+2028 as 500 characters with spaces in their place", async () => {
    const reason = `a\nb\u001bc\u007fd\u2028${"x".repeat(600)}`;

    const capabilities = await capabilitiesAfter(async () => ({ reason, state: "unavailable" }));

    expect(capabilities).toHaveLength(1);
    expect(capabilities?.[0]?.name).toBe("agent-device");
    expect(capabilities?.[0]?.reason).toHaveLength(500);
    expect(capabilities?.[0]?.reason?.startsWith("a b c d ")).toBe(true);
  });

  it("answers a reason that is only control characters as unknown", async () => {
    expect(
      await capabilitiesAfter(async () => ({ reason: "\n\u001b\u007f", state: "unavailable" })),
    ).toEqual([{ name: "agent-device", reason: "unknown", state: "unavailable" }]);
  });

  it("answers a source that reports a state outside the three as unavailable with reason `reported an invalid status`", async () => {
    expect(await capabilitiesAfter(async () => ({ state: "available" }))).toEqual([
      { name: "agent-device", state: "available" },
    ]);

    for (const state of ["broken", "AVAILABLE"]) {
      expect(await capabilitiesAfter(async () => ({ state }))).toEqual([
        { name: "agent-device", reason: "reported an invalid status", state: "unavailable" },
      ]);
    }
  });

  it.each([
    { reason: "fine", state: "available" },
    { reason: "no", state: "off" },
  ] as const)(
    "answers a source that reports $state with a reason as $state with none",
    async ({ reason, state }) => {
      expect(await capabilitiesAfter(async () => ({ reason, state }))).toEqual([
        { name: "agent-device", state },
      ]);
    },
  );

  it("answers a source that reports unavailable with no reason as unavailable with reason unknown", async () => {
    expect(await capabilitiesAfter(async () => ({ state: "unavailable" }))).toEqual([
      { name: "agent-device", reason: "unknown", state: "unavailable" },
    ]);
  });

  it("answers a source whose read throws as unavailable with reason `could not read agent-device's status`, and status.get still answers", async () => {
    expect(await capabilitiesAfter(async () => ({ state: "available" }))).toBeDefined();

    expect(
      await capabilitiesAfter(async () => {
        throw new Error("boom");
      }),
    ).toEqual([
      {
        name: "agent-device",
        reason: "could not read agent-device's status",
        state: "unavailable",
      },
    ]);
  });

  it("answers status.get within 1.5 s when a capability read takes 2 s, with unavailable and reason `could not read agent-device's status`", async () => {
    const clock = new FakeClock(1_000);
    const { dispatcher } = await buildDispatcher({
      capabilitySources: source(
        () =>
          new Promise((resolve) => clock.setTimer(2_000, () => resolve({ state: "available" }))),
      ),
      clock,
    });
    let settled = false;
    const answer = dispatcher.dispatch("status.get", {}, session()).then((result) => {
      settled = true;
      return result;
    });

    for (let elapsed = 0; elapsed < 1_500; elapsed += 100) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(100);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(true);
    expect((await answer).capabilities).toEqual([
      {
        name: "agent-device",
        reason: "could not read agent-device's status",
        state: "unavailable",
      },
    ]);
  });

  it("answers status.get with no capabilities field while the daemon's health is starting", async () => {
    const sources = source(async () => ({ state: "available" }));
    const running = await buildDispatcher({ capabilitySources: sources });
    const starting = await buildDispatcher({ capabilitySources: sources, health: "starting" });

    expect((await running.dispatcher.dispatch("status.get", {}, session())).capabilities).toEqual([
      { name: "agent-device", state: "available" },
    ]);
    expect(await starting.dispatcher.dispatch("status.get", {}, session())).not.toHaveProperty(
      "capabilities",
    );
  });
});
