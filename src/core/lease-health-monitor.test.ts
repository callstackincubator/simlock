import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import type { ObservedDevice, ObservedMark, ObservedRunState } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { type Config, FakeDriver, Registry } from "./index.js";
import type { DeviceLostReleaser } from "./lease-health-monitor.js";
import { LeaseHealthMonitor } from "./lease-health-monitor.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { SerializedDecision } from "./serialized-decision.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(overrides: Partial<Config["health"]> = {}): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    drivers: {},
    eventBuffer: { capacity: 100 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
        maxRetryBackoffMs: 5 * 60_000,
      },
    },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
      ...overrides,
    },
    idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100, heartbeatIntervalMs: 25 },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 2, maxRunning: 2 },
          ios: { maxDevices: 2, maxRunning: 2 },
          maxRunning: 4,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
  };
}

class RecordingReleaser implements DeviceLostReleaser {
  readonly leaseIds: string[] = [];

  constructor(private readonly registry: Registry) {}

  async releaseDeviceLost(leaseId: string): Promise<void> {
    this.leaseIds.push(leaseId);
    await this.registry.beginRelease(leaseId);
  }
}

async function createHarness(healthOverrides: Partial<Config["health"]> = {}) {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  let nextId = 1;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const claims = new DeviceOperationClaims();
  const decisions = new SerializedDecision();
  const catalog = new DriverCatalog([driver]);
  const lifecycle = new ManagedDeviceLifecycle(catalog, registry, decisions, claims, clock);
  const releaser = new RecordingReleaser(registry);
  const monitor = new LeaseHealthMonitor({
    clock,
    config: config(healthOverrides),
    drivers: catalog,
    eventBus,
    lifecycle,
    registry,
    releaser,
  });

  return {
    clock,
    driver,
    eventBus,
    monitor,
    registry,
    get releaseCalls() {
      return releaser.leaseIds;
    },
  };
}

let deviceCounter = 0;

async function seedLeased(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: { readonly driverDeviceId?: string; readonly requesterId?: string } = {},
) {
  deviceCounter += 1;
  const driverDeviceId = options.driverDeviceId ?? `simlock-${deviceCounter}`;
  const device = await harness.registry.registerDevice({
    driverData: { fakeDeviceId: driverDeviceId },
    driverDeviceId,
    provisionDuration: 0,
    spec,
  });
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  const lease = await harness.registry.createLease({
    deviceId: device.id,
    mode: "held",
    requesterId: options.requesterId ?? "agent-1",
    ownerId: options.requesterId ?? "agent-1",
    ttlDeadline: 10_000_000,
  });
  return { device, lease };
}

function observedDevice(
  driverDeviceId: string,
  runState: ObservedRunState,
  mark?: ObservedMark,
): ObservedDevice {
  return {
    address: "",
    deviceId: driverDeviceId,
    driverData: { fakeDeviceId: driverDeviceId },
    runState,
    ...(mark === undefined ? {} : { mark }),
  };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    await Promise.resolve();
  }
}

function makeReadyCalls(driver: FakeDriver): number {
  return driver.calls.filter((call) => call.operation === "makeReady").length;
}

function listManagedCalls(driver: FakeDriver): number {
  return driver.calls.filter((call) => call.operation === "listManaged").length;
}

function healthEvents(eventBus: EventBus) {
  return eventBus
    .replay()
    .filter(
      (event) =>
        event.event === "device.crash-detected" ||
        event.event === "device.recovered" ||
        event.event === "device.recovery-failed",
    );
}

describe("LeaseHealthMonitor", () => {
  it("never touches a leased device observed running", async () => {
    const harness = await createHarness();
    const { device } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "running")],
      processes: [],
    });

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();

    expect(makeReadyCalls(harness.driver)).toBe(0);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
    expect(harness.releaseCalls).toEqual([]);
    expect(healthEvents(harness.eventBus)).toEqual([]);
    harness.monitor.dispose();
  });

  it("does not recover on a single stopped reading but recovers on the second consecutive one", async () => {
    const harness = await createHarness();
    const { device, lease } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(0);

    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
    const crashEvents = harness.eventBus
      .replay()
      .filter((event) => event.event === "device.crash-detected");
    expect(crashEvents).toHaveLength(1);
    expect(crashEvents[0]).toMatchObject({ payload: { deviceId: device.id, leaseId: lease.id } });
    harness.monitor.dispose();
  });

  it("resets the stopped counter on an intervening running reading", async () => {
    const harness = await createHarness();
    const { device } = await seedLeased(harness);

    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();

    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "running")],
      processes: [],
    });
    harness.clock.advance(30_000);
    await flush();

    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(0);

    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    harness.monitor.dispose();
  });

  it("transitioning readings neither trigger recovery nor reset a pending stopped count", async () => {
    const harness = await createHarness();
    const { device } = await seedLeased(harness);

    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();

    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "transitioning")],
      processes: [],
    });
    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(0);

    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    harness.monitor.dispose();
  });

  it("a successful recovery calls recoverLeased under the right lease, clears recovery markers, and emits crash-detected then recovered", async () => {
    const harness = await createHarness();
    const { device, lease } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();

    const reboots = harness.driver.calls.filter((call) => call.operation === "makeReady");
    expect(reboots).toHaveLength(1);
    expect(reboots[0]?.arguments[0]).toMatchObject({ deviceId: device.driverDeviceId });

    const events = harness.eventBus
      .replay()
      .filter(
        (event) => event.event === "device.crash-detected" || event.event === "device.recovered",
      );
    expect(events.map((event) => event.event)).toEqual([
      "device.crash-detected",
      "device.recovered",
    ]);
    expect(events[1]).toMatchObject({
      payload: { attempts: 1, deviceId: device.id, leaseId: lease.id },
    });

    const recovered = harness.registry.snapshot.devices[0];
    expect(recovered?.state).toBe("leased");
    expect(recovered?.recoveringSince).toBeUndefined();
    expect(recovered?.recoveryAttempts).toBeUndefined();
    harness.monitor.dispose();
  });

  it("emits device.crash-detected once across a retry sequence, not per attempt", async () => {
    const harness = await createHarness();
    const { device } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.driver.failOn("makeReady", 1, new Error("boom"));

    harness.monitor.start();
    harness.clock.advance(30_000); // tick 1: counter=1
    await flush();
    harness.clock.advance(30_000); // tick 2: counter=2 -> attempt 1 dispatched, fails
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    expect(harness.registry.snapshot.devices[0]?.recoveryAttempts).toBe(1);

    harness.clock.advance(30_000); // tick 3: still stopped -> attempt 2 dispatched, enters backoff
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);

    harness.clock.advance(5_000); // backoff = recoveryBackoffMs * 2 ** (2 - 2)
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(2);

    expect(
      harness.eventBus.replay().filter((event) => event.event === "device.crash-detected"),
    ).toHaveLength(1);
    const recoveredEvents = harness.eventBus
      .replay()
      .filter((event) => event.event === "device.recovered");
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0]).toMatchObject({ payload: { attempts: 2 } });
    harness.monitor.dispose();
  });

  it("gives up after maxRecoveryAttempts failed reboots, emitting device.recovery-failed and releasing the lease exactly once", async () => {
    const harness = await createHarness();
    const { device, lease } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.driver.failOn("makeReady", 1, new Error("boom-1"));
    harness.driver.failOn("makeReady", 2, new Error("boom-2"));
    harness.driver.failOn("makeReady", 3, new Error("boom-3"));

    harness.monitor.start();
    harness.clock.advance(30_000); // tick 1: counter=1
    await flush();
    harness.clock.advance(30_000); // tick 2: attempt 1 fails
    await flush();
    harness.clock.advance(30_000); // tick 3: attempt 2 dispatched, backoff 5_000
    await flush();
    harness.clock.advance(5_000); // attempt 2 fires and fails
    await flush();
    harness.clock.advance(30_000); // tick 4: attempt 3 dispatched, backoff 10_000
    await flush();
    harness.clock.advance(10_000); // attempt 3 fires, fails, attempts exhausted -> gives up
    await flush();

    expect(makeReadyCalls(harness.driver)).toBe(3);
    expect(harness.releaseCalls).toEqual([lease.id]);
    const failedEvents = harness.eventBus
      .replay()
      .filter((event) => event.event === "device.recovery-failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      payload: {
        attempts: 3,
        deviceId: device.id,
        leaseId: lease.id,
        reason: "attempts-exhausted",
      },
    });
    expect(harness.registry.snapshot.leases).toEqual([]);
    harness.monitor.dispose();
  });

  it("gives up a device absent from driver reality after stableObservations ticks, but not on a single absent reading", async () => {
    const harness = await createHarness();
    const { device, lease } = await seedLeased(harness);
    harness.driver.setManagedReality({ devices: [], processes: [] });

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();
    expect(harness.releaseCalls).toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");

    harness.clock.advance(30_000);
    await flush();
    expect(harness.releaseCalls).toEqual([lease.id]);
    const failedEvents = harness.eventBus
      .replay()
      .filter((event) => event.event === "device.recovery-failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      payload: {
        attempts: 0,
        deviceId: device.id,
        error: "",
        leaseId: lease.id,
        reason: "device-missing",
      },
    });
    harness.monitor.dispose();
  });

  it("gives up for provenance drift only while running; the same drift while stopped follows the crash path instead", async () => {
    const harness = await createHarness();
    const { device: runningDevice, lease: runningLease } = await seedLeased(harness, {
      driverDeviceId: "simlock-running",
    });
    const { device: stoppedDevice } = await seedLeased(harness, {
      driverDeviceId: "simlock-stopped",
      requesterId: "agent-2",
    });
    const drift: ObservedMark = { durable: "tok-a", erasable: undefined, erasableReadable: true };

    harness.driver.setManagedReality({
      devices: [
        observedDevice("simlock-running", "running", drift),
        observedDevice("simlock-stopped", "stopped", drift),
      ],
      processes: [],
    });

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();

    expect(harness.releaseCalls).toEqual([runningLease.id]);
    const failedEvents = harness.eventBus
      .replay()
      .filter((event) => event.event === "device.recovery-failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      payload: { deviceId: runningDevice.id, error: "erased", reason: "provenance-drift" },
    });
    expect(makeReadyCalls(harness.driver)).toBe(0);

    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    expect(
      harness.registry.snapshot.devices.find((candidate) => candidate.id === stoppedDevice.id)
        ?.state,
    ).toBe("leased");
    harness.monitor.dispose();
  });

  it("a listManaged failure causes no recovery and no lease loss this tick", async () => {
    const harness = await createHarness();
    const { device } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.driver.failOn("listManaged", 1, new Error("adb not found"));

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();

    expect(makeReadyCalls(harness.driver)).toBe(0);
    expect(harness.releaseCalls).toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
    expect(healthEvents(harness.eventBus)).toEqual([]);

    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    harness.monitor.dispose();
  });

  it("caps concurrent recoveries at maxConcurrentRecoveries, leaving a second crashed device for a later tick", async () => {
    const harness = await createHarness({ maxConcurrentRecoveries: 1 });
    await seedLeased(harness, { driverDeviceId: "simlock-a" });
    await seedLeased(harness, { driverDeviceId: "simlock-b", requesterId: "agent-2" });

    harness.driver.setManagedReality({
      devices: [observedDevice("simlock-a", "stopped"), observedDevice("simlock-b", "stopped")],
      processes: [],
    });
    harness.driver.hangMakeReady();

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();

    expect(makeReadyCalls(harness.driver)).toBe(1);

    harness.driver.releaseMakeReady();
    await flush();
    harness.monitor.dispose();
  });

  it("keeps ticking on schedule for other devices while a slow recovery stays in flight, without double-dispatching it", async () => {
    const harness = await createHarness();
    await seedLeased(harness, { driverDeviceId: "simlock-hung" });
    const { device: healthyDevice } = await seedLeased(harness, {
      driverDeviceId: "simlock-healthy",
      requesterId: "agent-2",
    });

    harness.driver.setManagedReality({
      devices: [
        observedDevice("simlock-hung", "stopped"),
        observedDevice("simlock-healthy", "running"),
      ],
      processes: [],
    });
    harness.driver.hangMakeReady();

    harness.monitor.start();
    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
    expect(listManagedCalls(harness.driver)).toBe(2);

    harness.clock.advance(30_000);
    await flush();
    harness.clock.advance(30_000);
    await flush();

    expect(listManagedCalls(harness.driver)).toBe(4);
    expect(makeReadyCalls(harness.driver)).toBe(1);
    expect(
      harness.registry.snapshot.devices.find((candidate) => candidate.id === healthyDevice.id)
        ?.state,
    ).toBe("leased");

    harness.driver.releaseMakeReady();
    await flush();
    harness.monitor.dispose();
  });

  it("performs no driver calls when health.enabled is false", async () => {
    const harness = await createHarness({ enabled: false });
    await seedLeased(harness);
    harness.driver.setManagedReality({ devices: [], processes: [] });

    harness.monitor.start();
    harness.clock.advance(10_000_000);
    await flush();

    expect(harness.driver.calls).toEqual([]);
    harness.monitor.dispose();
  });

  it("dispose() cancels the tick timer and any pending backoff timer", async () => {
    const harness = await createHarness();
    const { device } = await seedLeased(harness);
    harness.driver.setManagedReality({
      devices: [observedDevice(device.driverDeviceId, "stopped")],
      processes: [],
    });
    harness.driver.failOn("makeReady", 1, new Error("boom"));

    harness.monitor.start();
    harness.clock.advance(30_000); // tick 1
    await flush();
    harness.clock.advance(30_000); // tick 2: attempt 1 dispatched, fails
    await flush();
    harness.clock.advance(30_000); // tick 3: attempt 2 dispatched, enters backoff -- pending timer
    await flush();

    expect(harness.clock.pendingTimerCount).toBeGreaterThan(0);

    harness.monitor.dispose();
    expect(harness.clock.pendingTimerCount).toBe(0);

    harness.clock.advance(1_000_000);
    await flush();
    expect(makeReadyCalls(harness.driver)).toBe(1);
  });
});
