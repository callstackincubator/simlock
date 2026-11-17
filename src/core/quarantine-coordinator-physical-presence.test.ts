import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { type FakePhysicalDevice } from "./fake-driver.js";
import { FakeDriver, loadTestRegistry, testComponentWiring, testStateOf } from "./testing.js";
import { createCore, loadConfig } from "./index.js";
import type { PhysicalDevice } from "./domain.js";
import { retryConfig, createHarness, flush } from "./test-quarantine-coordinator.js";

// why: index.ts does not export the coordinator, so its retry timers, claims and give-up order are an ordering the surface cannot force.
describe("QuarantineCoordinator and enrollment of a quarantined physical device (ADR 0022 §2)", () => {
  const FIRST = "00008110-001A2B3C4D5E";
  const SECOND = "00008110-00FF00FF00FF";
  const DEVICES: readonly FakePhysicalDevice[] = [
    { apps: [], ids: [FIRST], model: "iPhone 15 Pro", osVersion: "18.4" },
    { apps: [], ids: [SECOND], model: "iPhone 15 Pro", osVersion: "18.4" },
  ];

  async function build() {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, physicalDevices: DEVICES, platform: "ios" });
    for (const id of [FIRST, SECOND]) driver.setPhysicalPresence(id, true);
    const filesystem = new MemoryFilesystem();
    const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
    let next = 1;
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: { generate: () => `${next++}` },
    });
    const config = await loadConfig({ filesystem, systemStats });
    const core = createCore({
      clock,
      config,
      drivers: [driver],
      eventBus,
      registry,
      state: testStateOf(registry),
      systemStats,
      ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
    });
    return { clock, config, core, driver, registry };
  }

  type Harness = Awaited<ReturnType<typeof build>>;

  async function enrollQuarantined(harness: Harness, driverId: string): Promise<string> {
    const { device } = await harness.core.enrollment.add("ios", driverId);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.core.quarantine.enterFromStalledTransition(device.id, "reclaiming");
    return device.id;
  }

  function reclaimedIds(harness: Harness): unknown[] {
    return harness.driver.calls
      .filter((call) => call.operation === "reclaim")
      .map((call) => (call.arguments[0] as { deviceId: string }).deviceId);
  }

  function record(harness: Harness, id: string): PhysicalDevice | undefined {
    return harness.registry.snapshot.devices.find(
      (device): device is PhysicalDevice => device.physical && device.id === id,
    );
  }

  it("makes a re-enrolled quarantined physical device ready with no quarantine fields, and no driver reclaim call when its next retry falls due", async () => {
    const harness = await build();
    const enrolled = await enrollQuarantined(harness, FIRST);
    await enrollQuarantined(harness, SECOND);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;

    await harness.core.enrollment.add("ios", FIRST);
    harness.clock.advance(backoff);
    await flush();

    expect(record(harness, enrolled)).toMatchObject({ id: enrolled, state: "ready" });
    expect(record(harness, enrolled)).not.toHaveProperty("quarantineNextRetryAt");
    expect(reclaimedIds(harness)).toEqual([SECOND]);
  });

  it("makes a removed quarantined physical device deleted, and no driver call when its next retry falls due", async () => {
    const harness = await build();
    const removed = await enrollQuarantined(harness, FIRST);
    await enrollQuarantined(harness, SECOND);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;

    await harness.core.enrollment.remove(FIRST);
    harness.clock.advance(backoff);
    await flush();

    expect(record(harness, removed)?.state).toBe("deleted");
    expect(reclaimedIds(harness)).toEqual([SECOND]);
    expect(
      harness.driver.calls.filter(
        (call) =>
          call.operation !== "inspectPhysical" &&
          (call.arguments[0] as { deviceId?: string } | undefined)?.deviceId === FIRST,
      ),
    ).toEqual([]);
  });

  it.each(["add", "remove"] as const)(
    "answers DEVICE_BUSY reclaiming to %s of a physical device whose quarantine retry is inside its driver reclaim",
    async (operation) => {
      const harness = await build();
      await enrollQuarantined(harness, FIRST);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = vi.fn();
      vi.spyOn(harness.driver, "reclaim").mockImplementation(async () => {
        reached();
        await gate;
        return { state: "ready", strategy: "uninstall" };
      });

      harness.clock.advance(harness.config.warmPool.quarantine.retryBackoffMs);
      await flush();
      expect(reached).toHaveBeenCalledTimes(1);

      const attempt =
        operation === "add"
          ? harness.core.enrollment.add("ios", FIRST)
          : harness.core.enrollment.remove(FIRST);
      await expect(attempt).rejects.toMatchObject({
        name: "DeviceBusyError",
        reason: "reclaiming",
      });
      release();
      await flush();
    },
  );

  it("makes no driver call when a physical quarantine retry falls due while an add holds the claim, keeps its attempt count, and runs one retryBackoffMs later when the add was refused", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness, FIRST);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;
    const original = harness.driver.inspectPhysical.bind(harness.driver);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = vi.fn();
    vi.spyOn(harness.driver, "inspectPhysical").mockImplementation(async (identifier) => {
      reads += 1;
      if (reads < 2) return original(identifier);
      held();
      await gate;
      return { enrollable: false, message: "locked: unlock it", reason: "locked" };
    });
    const adding = harness.core.enrollment.add("ios", FIRST);
    const refused = expect(adding).rejects.toMatchObject({ name: "DeviceNotEnrollableError" });
    await vi.waitFor(() => expect(held).toHaveBeenCalled());

    harness.clock.advance(backoff);
    await flush();

    expect(reclaimedIds(harness)).toEqual([]);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    release();
    await refused;
    harness.clock.advance(backoff - 1);
    await flush();
    expect(reclaimedIds(harness)).toEqual([]);
    harness.clock.advance(1);
    await flush();

    expect(reclaimedIds(harness)).toEqual([FIRST]);
  });
});

describe("QuarantineCoordinator retry of a physical device that is not present (ADR 0022 §2)", () => {
  const FIRST = "00008110-001A2B3C4D5E";
  const PROBE_INTERVAL_MS = 7_000;
  const DEVICES: readonly FakePhysicalDevice[] = [
    { apps: [], hardwareSerial: "SER-1", ids: [FIRST], model: "iPhone 15 Pro", osVersion: "18.4" },
  ];

  async function build() {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, physicalDevices: DEVICES, platform: "ios" });
    const filesystem = new MemoryFilesystem();
    const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
    let next = 1;
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: { generate: () => `${next++}` },
    });
    const config = await loadConfig({
      filesystem,
      overrides: { health: { probeIntervalMs: PROBE_INTERVAL_MS } },
      systemStats,
    });
    const core = createCore({
      clock,
      config,
      drivers: [driver],
      eventBus,
      registry,
      state: testStateOf(registry),
      systemStats,
      ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
    });
    return { clock, config, core, driver, eventBus, registry };
  }

  type Harness = Awaited<ReturnType<typeof build>>;

  async function enrollQuarantined(harness: Harness): Promise<string> {
    const { device } = await harness.core.enrollment.add("ios", FIRST);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.core.quarantine.enterFromStalledTransition(device.id, "reclaiming");
    return device.id;
  }

  async function advance(harness: Harness, ms: number): Promise<void> {
    harness.clock.advance(ms);
    for (let round = 0; round < 5; round += 1) await flush();
  }

  function record(harness: Harness, id: string): PhysicalDevice | undefined {
    return harness.registry.snapshot.devices.find(
      (device): device is PhysicalDevice => device.physical && device.id === id,
    );
  }

  function verbCalls(harness: Harness, operation: "reclaim" | "destroy"): unknown[] {
    return harness.driver.calls.filter((call) => call.operation === operation);
  }

  it("a physical retry while not present makes no reclaim or destroy call, keeps quarantineAttempts, writes quarantineNextRetryAt as now plus health.probeIntervalMs, and re-arms for that time; a virtual retry reads no presence and deletes the device", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    const backoff = harness.config.warmPool.quarantine.retryBackoffMs;
    harness.driver.setPhysicalPresence(FIRST, false, { reason: "locked" });

    await advance(harness, backoff);

    expect(verbCalls(harness, "reclaim")).toEqual([]);
    expect(verbCalls(harness, "destroy")).toEqual([]);
    expect(record(harness, id)).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 1_000 + backoff + PROBE_INTERVAL_MS,
      state: "quarantined",
    });
    await advance(harness, PROBE_INTERVAL_MS - 1);
    expect(verbCalls(harness, "reclaim")).toEqual([]);
    harness.driver.setPhysicalPresence(FIRST, true);
    await advance(harness, 1);
    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)?.state).toBe("ready");

    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    const virtual = await createHarness({ clock, driver, target: { state: "reclaiming" } });
    await virtual.coordinator.enterFromStalledTransition(virtual.target.id, "reclaiming");
    virtual.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    expect(virtual.driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
    expect(virtual.driver.calls.map((call) => call.operation)).not.toContain("listPresentPhysical");
    expect(virtual.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
  });

  it("a physical retry that runs while present and fails counts one attempt", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    harness.driver.setPhysicalPresence(FIRST, false);
    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    expect(verbCalls(harness, "reclaim")).toEqual([]);

    harness.driver.setPhysicalPresence(FIRST, true);
    await advance(harness, PROBE_INTERVAL_MS);

    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
  });

  it("a physical retry that fails while present, then finds the device gone, keeps the one attempt it counted", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    harness.driver.failOn("reclaim", 1, new Error("uninstall exploded"));
    harness.driver.setPhysicalPresence(FIRST, true);
    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });

    harness.driver.setPhysicalPresence(FIRST, false);
    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs * 2);

    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
  });

  it("a physical retry reads presence with the record's driverDeviceId and hardwareSerial", async () => {
    const harness = await build();
    await enrollQuarantined(harness);
    harness.driver.setPhysicalPresence(FIRST, true);

    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);

    expect(
      harness.driver.calls
        .filter((call) => call.operation === "listPresentPhysical")
        .map((call) => call.arguments[0]),
    ).toEqual([[{ driverDeviceId: FIRST, hardwareSerial: "SER-1" }]]);
  });

  it("a physical retry whose presence read rejects makes no reclaim or destroy call, keeps quarantineAttempts, and re-arms after health.probeIntervalMs", async () => {
    const harness = await build();
    const id = await enrollQuarantined(harness);
    harness.driver.setPhysicalPresence(FIRST, true);
    const read = vi
      .spyOn(harness.driver, "listPresentPhysical")
      .mockRejectedValueOnce(new Error("link down"));

    await advance(harness, harness.config.warmPool.quarantine.retryBackoffMs);

    expect(read).toHaveBeenCalledTimes(1);
    expect(verbCalls(harness, "reclaim")).toEqual([]);
    expect(verbCalls(harness, "destroy")).toEqual([]);
    expect(record(harness, id)).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    await advance(harness, PROBE_INTERVAL_MS - 1);
    expect(verbCalls(harness, "reclaim")).toEqual([]);
    await advance(harness, 1);
    expect(verbCalls(harness, "reclaim")).toHaveLength(1);
    expect(record(harness, id)?.state).toBe("ready");
  });
});
