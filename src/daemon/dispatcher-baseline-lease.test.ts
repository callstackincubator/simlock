import { describe, expect, it, vi } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { DispatchError } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, gibibyte, session } from "./test-dispatcher.js";

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

describe("Dispatcher: a baseline the driver calls stale", () => {
  const reason = "saved before simulators stopped sharing folders; save it again";

  async function built(logger?: JsonLinesLogger) {
    const clock = new FakeClock(1_000);
    const harness = await buildDispatcher({
      clock,
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
      ...(logger === undefined ? {} : { engine: { logger } }),
      warmPool: { baselineLearnAfter: 1, refillDelayMs: 0 },
    });
    const real = harness.driver.listSources.bind(harness.driver);
    return {
      ...harness,
      clock,
      markStale: () =>
        vi
          .spyOn(harness.driver, "listSources")
          .mockImplementation(async () =>
            (await real()).map((source) => ({ ...source, staleReason: reason })),
          ),
      provisions: () =>
        harness.driver.calls.filter((call) => call.operation === "provision").length,
      request: () =>
        harness.dispatcher
          .dispatch("lease.request", { baseline: "checkout", platform: "ios" }, session())
          .catch((error: unknown) => error),
      restart: async () => harness.engine.core.converge(await harness.engine.core.readStartup()),
      save: async () => {
        const first = await harness.dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
          session(),
        );
        await harness.dispatcher.dispatch(
          "baseline.save",
          { leaseId: first.lease.id, name: "checkout" },
          session({ role: "admin" }),
        );
      },
    };
  }

  async function learned(harness: Awaited<ReturnType<typeof built>>): Promise<void> {
    await harness.restart();
    await harness.save();
    const granted = await harness.request();
    await harness.dispatcher.dispatch(
      "lease.release",
      { leaseId: (granted as { lease: { id: string } }).lease.id },
      session(),
    );
  }

  it("answers BASELINE_STALE from the first request after the worker starts or after its save, and warms no copy of it", async () => {
    const control = await built();
    await learned(control);
    const warmed = control.provisions();
    await control.engine.core.passWarmPool();
    expect(control.provisions(), "a fresh baseline's learned kind is warmed").toBeGreaterThan(
      warmed,
    );

    const restarted = await built();
    await learned(restarted);
    restarted.markStale();
    await restarted.restart();
    const provisioned = restarted.provisions();
    await restarted.engine.core.passWarmPool();
    expect(restarted.provisions(), "no copy of a stale baseline is warmed").toBe(provisioned);
    expect(await restarted.request()).toMatchObject({
      code: "BASELINE_STALE",
      message: `baseline checkout is stale: ${reason}`,
    });

    const saved = await built();
    saved.markStale();
    await saved.save();
    expect(await saved.request()).toMatchObject({
      code: "BASELINE_STALE",
      message: `baseline checkout is stale: ${reason}`,
    });
  });

  it("goes on, logging it, when the check at startup or after a save fails", async () => {
    const sink = new MemoryLogSink();
    const harness = await built(new JsonLinesLogger({ clock: new FakeClock(0), sink }));
    vi.spyOn(harness.engine.core.baselines, "checkStale").mockRejectedValue(
      new Error("catalog unreadable"),
    );

    await expect(harness.restart()).resolves.toBeUndefined();
    await expect(harness.save()).resolves.toBeUndefined();

    expect(sink.records.map((record) => record.message)).toEqual([
      "could not check baselines at startup: catalog unreadable",
      "could not check baselines after a save: catalog unreadable",
    ]);
  });
});
