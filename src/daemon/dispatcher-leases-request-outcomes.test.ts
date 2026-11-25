import { describe, expect, it, vi } from "vitest";
import { type Config, BootTimeoutError, DriverCrashError } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import type { DispatcherOptions } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, flush, gibibyte, seedSlimDevice, session } from "./test-dispatcher.js";

describe("Dispatcher: lease.request requires", () => {
  const IOS = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
  const REQUIRES = { ...IOS, requires: ["agent-device"] } as const;
  type SourceState = { state: "available" | "off" | "unavailable" };

  function sources(initial: SourceState["state"]) {
    const current: SourceState = { state: initial };
    return {
      current,
      list: [{ name: "agent-device", read: async () => ({ state: current.state }) }] as NonNullable<
        DispatcherOptions["capabilitySources"]
      >,
    };
  }

  it("refuses a request on a worker whose agent-device is off with CAPABILITY_MISSING, message `This worker cannot serve agent-device`, details naming it, stores nothing and emits no event", async () => {
    const capability = sources("available");
    const { dispatcher, eventBus, registry } = await buildDispatcher({
      capabilitySources: capability.list,
    });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { ...REQUIRES, requesterId: "a" },
      session(),
    );
    await dispatcher.dispatch("lease.release", { leaseId: grant.lease.id }, session());
    // why: the release deletes the device in the background; its event must land before the baseline.
    await vi.waitFor(() =>
      expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["deleted"]),
    );
    capability.current.state = "off";
    const requestsBefore = registry.leaseRequests().length;
    const eventsBefore = eventBus.replay().length;

    await expect(
      dispatcher.dispatch("lease.request", { ...REQUIRES, requesterId: "b" }, session()),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      message: "This worker cannot serve agent-device",
    });

    expect(registry.leaseRequests()).toHaveLength(requestsBefore);
    expect(eventBus.replay()).toHaveLength(eventsBefore);
  });

  it("refuses the same request from the gateway uplink as a probe, the same way, with no lease.declined", async () => {
    const capability = sources("unavailable");
    const { dispatcher, eventBus, registry } = await buildDispatcher({
      capabilitySources: capability.list,
    });

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...REQUIRES, fleetRequestId: "req_gw1", noWait: true },
        session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      message: "This worker cannot serve agent-device",
    });

    expect(registry.leaseRequests()).toEqual([]);
    expect(eventBus.replay().map((event) => event.event)).not.toContain("lease.declined");
  });

  it("names only x-other when requires is [x-other, agent-device] and only agent-device is available", async () => {
    const { dispatcher } = await buildDispatcher({
      capabilitySources: sources("available").list,
    });

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...IOS, requires: ["x-other", "agent-device"] },
        session(),
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["x-other"] },
      message: "This worker cannot serve x-other",
    });
  });

  it("refuses within 1.5 s with CAPABILITY_MISSING when the capability source takes 2 s", async () => {
    const clock = new FakeClock(1_000);
    const { dispatcher } = await buildDispatcher({
      capabilitySources: [
        {
          name: "agent-device",
          read: () =>
            new Promise((resolve) => clock.setTimer(2_000, () => resolve({ state: "available" }))),
        },
      ],
      clock,
    });
    let settled = false;
    const answer = dispatcher.dispatch("lease.request", REQUIRES, session()).then(
      () => "granted",
      (error: unknown) => error,
    );
    void answer.then(() => {
      settled = true;
    });

    for (let elapsed = 0; elapsed < 1_500; elapsed += 100) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(100);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(true);
    expect(await answer).toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("grants a queued request with requires once a device frees, even though the capability turned unavailable while it waited", async () => {
    const capability = sources("available");
    const { dispatcher, engine } = await buildDispatcher({ capabilitySources: capability.list });
    const first = await dispatcher.dispatch(
      "lease.request",
      { ...IOS, requesterId: "h1" },
      session(),
    );
    await dispatcher.dispatch("lease.request", { ...IOS, requesterId: "h2" }, session());
    const waiting = dispatcher.dispatch(
      "lease.request",
      { ...REQUIRES, requesterId: "w" },
      session(),
    );
    await expect.poll(() => engine.queueDepth).toBe(1);
    capability.current.state = "unavailable";

    await dispatcher.dispatch("lease.release", { leaseId: first.lease.id }, session());

    await expect(waiting).resolves.toMatchObject({ lease: { requesterId: "w" } });
  });

  it("accepts requires with an idempotencyKey, and a replay answers the first request's result, or IDEMPOTENCY_CONFLICT when the set of names differs, before it checks capabilities", async () => {
    const capability = sources("available");
    const bank = { name: "bank-network", read: async () => ({ state: "available" }) };
    const { dispatcher, state } = await buildDispatcher({
      capabilitySources: [...capability.list, bank],
    });
    const ask = { ...IOS, idempotencyKey: "key-1", requesterId: "a" } as const;
    const names = ["agent-device", "bank-network"];

    const first = await dispatcher.dispatch(
      "lease.request",
      { ...ask, requires: names },
      session(),
    );

    const reordered = await dispatcher.dispatch(
      "lease.request",
      { ...ask, requires: [...names].reverse() },
      session(),
    );
    expect(reordered.lease.id).toBe(first.lease.id);
    capability.current.state = "unavailable";
    const afterUnavailable = await dispatcher.dispatch(
      "lease.request",
      { ...ask, requires: names },
      session(),
    );
    expect(afterUnavailable.lease.id).toBe(first.lease.id);
    // why: the key is the requester's own, so another requester sending it is no replay and is checked.
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...ask, requesterId: "c", requires: names },
        session(),
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
    for (const requires of [[...names, "vpn-eu"], names.slice(0, 1), undefined]) {
      const conflict = await dispatcher
        .dispatch(
          "lease.request",
          { ...ask, ...(requires === undefined ? {} : { requires }) },
          session(),
        )
        .catch((error: unknown) => error);
      expect(classifyError(conflict)).toBe("IDEMPOTENCY_CONFLICT");
      expect((conflict as Error).message).toContain("or required capabilities");
    }
    const restarted = (await buildDispatcher({ capabilitySources: [bank], state })).dispatcher;
    const afterRestart = await restarted.dispatch(
      "lease.request",
      { ...ask, requires: [...names].reverse() },
      session(),
    );
    expect(afterRestart.lease.id).toBe(first.lease.id);
    const afterRestartConflict = await restarted
      .dispatch("lease.request", { ...ask, requires: [...names, "vpn-eu"] }, session())
      .catch((error: unknown) => error);
    expect(classifyError(afterRestartConflict)).toBe("IDEMPOTENCY_CONFLICT");

    capability.current.state = "available";
    const empty = { ...IOS, idempotencyKey: "key-2", requesterId: "b" } as const;
    const withEmpty = await dispatcher.dispatch(
      "lease.request",
      { ...empty, requires: [] },
      session(),
    );
    const without = await dispatcher.dispatch("lease.request", empty, session());
    expect(without.lease.id).toBe(withEmpty.lease.id);
  });

  it.each([
    ["absent", {}],
    ["[]", { requires: [] }],
  ])(
    "a request with requires %s is granted on a worker whose agent-device is off, and lease.requested's requestSpec has no requires",
    async (_label, extra) => {
      const { dispatcher, eventBus } = await buildDispatcher({
        capabilitySources: sources("off").list,
      });

      await dispatcher.dispatch("lease.request", { ...IOS, ...extra }, session());

      const requested = eventBus.replay().find((event) => event.event === "lease.requested");
      expect(requested?.payload).toMatchObject({ requestSpec: IOS });
      expect(JSON.stringify(requested?.payload)).not.toContain("requires");
    },
  );

  it("a request with requires is granted as today on a worker with the capability, and its requestSpec has no requires", async () => {
    const { dispatcher, eventBus } = await buildDispatcher({
      capabilitySources: sources("available").list,
    });

    const grant = await dispatcher.dispatch("lease.request", REQUIRES, session());

    expect(grant.device.spec).toMatchObject({ model: "iPhone 17 Pro", platform: "ios" });
    const requested = eventBus.replay().find((event) => event.event === "lease.requested");
    expect(requested?.payload).toMatchObject({ requestSpec: IOS });
    expect(JSON.stringify(requested?.payload)).not.toContain("requires");
  });
});

describe("Dispatcher: lease.request at new-devices-paused", () => {
  const slimmable = { slimmableOsVersions: ["26.5"] };
  const ask = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
  const slim = { ...ask, mode: "slim" } as const;
  const asker = () => session({ principal: "tok_asker" });
  const waiting = (built: Awaited<ReturnType<typeof buildDispatcher>>) =>
    built.dispatcher.dispatch("list.get", { kind: "requests" }, session({ role: "admin" }));
  const fixed: Config["capacity"] = { strategy: "fixed", config: { maxRunning: 4 } };

  it.each([
    { name: "needs a new device", seed: undefined, input: ask, options: {} },
    { name: "boots a shut-down device", seed: "shutdown", input: slim, options: {} },
    {
      name: "needs the reboot of an idle device for its except list",
      seed: "ready",
      input: { ...slim, except: ["store"] },
      options: {},
    },
    {
      name: "is refused for RAM too",
      seed: undefined,
      input: ask,
      options: {
        capacity: {
          strategy: "resource",
          config: {
            limits: {
              android: { maxDevices: 1, maxRunning: 1 },
              ios: { maxDevices: 4, maxRunning: 4 },
              maxRunning: 6,
            },
            ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 30 * gibibyte },
          },
        },
      },
    },
    {
      name: "runs under the fixed strategy",
      seed: undefined,
      input: ask,
      options: { capacity: fixed },
    },
  ] as const)(
    "a request that $name waits, or gets NO_CAPACITY under noWait, with memory-pressure",
    async (row) => {
      const start = async () => {
        const built = await buildDispatcher({
          driverOptions: slimmable,
          memoryPressureStep: "new-devices-paused",
          ...row.options,
        });
        if (row.seed !== undefined) await seedSlimDevice(built, row.seed);
        return { built, seededCalls: built.driver.calls.length };
      };
      const driven = (world: Awaited<ReturnType<typeof start>>) =>
        world.built.driver.calls
          .slice(world.seededCalls)
          .filter((call) => ["provision", "makeReady", "shutdown"].includes(call.operation));

      const waiter = await start();
      void waiter.built.dispatcher
        .dispatch("lease.request", row.input, asker())
        .catch(() => undefined);
      await flush();
      const listed = await waiting(waiter.built);
      const refused = await start();

      await expect(
        refused.built.dispatcher.dispatch("lease.request", { ...row.input, noWait: true }, asker()),
      ).rejects.toMatchObject({
        code: "NO_CAPACITY",
        details: { capacityReason: "memory-pressure" },
      });
      expect(listed).toMatchObject([{ reason: "memory-pressure", stage: "queued" }]);
      expect(driven(waiter)).toEqual([]);
      expect(driven(refused)).toEqual([]);
    },
  );

  it("grants a request that fits an idle booted device, and does not evict an idle device of another kind", async () => {
    const granted = await buildDispatcher({
      driverOptions: slimmable,
      memoryPressureStep: "new-devices-paused",
    });
    const registered = await seedSlimDevice(granted, "ready");
    await expect(
      granted.dispatcher.dispatch("lease.request", slim, asker()),
    ).resolves.toMatchObject({ device: { id: registered.id } });

    const limited = await buildDispatcher({
      capacity: {
        strategy: "resource",
        config: {
          limits: {
            android: { maxDevices: 1, maxRunning: 1 },
            ios: { maxDevices: 4, maxRunning: 1 },
            maxRunning: 6,
          },
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
        },
      },
      driverOptions: slimmable,
      memoryPressureStep: "new-devices-paused",
    });
    const idle = await seedSlimDevice(limited, "ready");
    await expect(
      limited.dispatcher.dispatch("lease.request", { ...ask, mode: "full", noWait: true }, asker()),
    ).rejects.toMatchObject({ details: { capacityReason: "memory-pressure" } });
    expect(limited.registry.snapshot.virtualDevices.find((d) => d.id === idle.id)?.state).toBe(
      "ready",
    );
  });

  it.each(["none", "warming-paused"] as const)(
    "a request waiting on memory pressure reads memory-pressure, then is served when the step lifts to %s with no other event",
    async (lifted) => {
      const built = await buildDispatcher({ memoryPressureStep: "new-devices-paused" });
      let granted: unknown;
      void built.dispatcher.dispatch("lease.request", ask, asker()).then((grant) => {
        granted = grant;
      });
      await flush();
      const before = await waiting(built);

      built.setMemoryPressure(lifted);
      built.eventBus.emit(
        "memory.pressure-changed",
        { from: "new-devices-paused", to: lifted },
        "test",
      );

      await flush();

      expect(before).toMatchObject([{ reason: "memory-pressure" }]);
      expect(granted).toMatchObject({ lease: { ownerId: "tok_asker" } });
    },
  );
});

describe("Dispatcher: lease.request whose device fails to boot", () => {
  it("answers a boot timeout or failed boot of a new or shut-down device as PROVISION_FAILED with the boot's message", async () => {
    const ask = {
      mode: "slim",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const timedOut = /^Timed out waiting for device to boot: /;
    const failed = /^Device failed to boot: .+: simulator exited$/;
    const cases = [
      ["a new device", new BootTimeoutError("sim-1"), timedOut],
      ["a new device", new DriverCrashError("simulator exited"), failed],
      ["a shut-down device", new BootTimeoutError("sim-1"), timedOut],
      ["a shut-down device", new DriverCrashError("simulator exited"), failed],
    ] as const;

    for (const [target, error, message] of cases) {
      const name = `${target}: ${error.name}`;
      const built = await buildDispatcher({ driverOptions: { slimmableOsVersions: ["26.5"] } });
      if (target === "a shut-down device") {
        await seedSlimDevice(built, "shutdown");
        // why: call 1 of makeReady is the seed's own boot; the waiter's boot is call 2.
        built.driver.failOn("makeReady", 2, error);
      } else {
        built.driver.failOn("makeReady", 1, error);
      }

      const refusal = await built.dispatcher
        .dispatch("lease.request", ask, session())
        .catch((caught: unknown) => caught);

      expect(
        built.eventBus.replay().find((event) => event.event === "lease.rejected")?.payload,
        name,
      ).toMatchObject({ reason: "boot-timeout" });
      expect(classifyError(refusal) ?? "INTERNAL", name).toBe("PROVISION_FAILED");
      expect((refusal as Error).message, name).toMatch(message);
    }
  });
});

describe("Dispatcher: a replay of a failed lease.request", () => {
  it("answers a classified failure with its stored code and message, and an unclassified one as INTERNAL with a generic message", async () => {
    const ask = {
      idempotencyKey: "key-1",
      mode: "slim",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    async function replayAfter(operation: "makeReady" | "resolveSpec", error: Error) {
      const built = await buildDispatcher({ driverOptions: { slimmableOsVersions: ["26.5"] } });
      built.driver.failOn(operation, 1, error);
      await built.dispatcher.dispatch("lease.request", ask, session()).catch(() => undefined);
      const replay = await built.dispatcher
        .dispatch("lease.request", ask, session())
        .catch((caught: unknown) => caught);
      return { code: classifyError(replay), message: (replay as Error).message };
    }

    const classified = await replayAfter("makeReady", new BootTimeoutError("sim-1"));
    const unclassified = await replayAfter(
      "resolveSpec",
      new Error("/Users/someone/secret/path exploded"),
    );

    expect([classified, unclassified]).toEqual([
      {
        code: "PROVISION_FAILED",
        message: expect.stringMatching(/^Timed out waiting for device to boot: /),
      },
      { code: "INTERNAL", message: "Internal error" },
    ]);
  });
});
