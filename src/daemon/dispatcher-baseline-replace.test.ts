import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { buildDispatcher, gibibyte, session } from "./test-dispatcher.js";

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
