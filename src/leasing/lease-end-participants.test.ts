import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import {
  type Config,
  type DeviceRequest,
  type DriverDevice,
  type LeaseGrant,
  Registry,
  UnknownLeaseError,
} from "../core/index.js";
import { FakeDriver, type FakeDriverOptions, testComponentWiring } from "../core/testing.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import type { EndedLease, LeaseEndParticipant } from "./lease-ports.js";
import { createTestEngine, type TestEngine } from "./testing.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const END_WAIT_MS = 600_000;
const PROBE_MS = 30_000;

const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const otherRequest = { model: "iPhone 15", osVersion: "26.5", platform: "ios" } as const;
const physicalRequest = {
  model: "iPhone 15 Pro",
  physical: true,
  platform: "ios",
} as const satisfies DeviceRequest;

interface Observed {
  readonly claimed: boolean;
  readonly deviceState: string | undefined;
  readonly events: readonly string[];
  readonly leaseCount: number;
  readonly marker: string | undefined;
}

interface RecordedCall {
  readonly abortedAtCall: boolean;
  readonly ended: EndedLease;
  readonly observed: Observed | undefined;
  readonly signal: AbortSignal;
  reject(error: Error): void;
  resolve(): void;
}

class TestParticipant implements LeaseEndParticipant {
  readonly calls: RecordedCall[] = [];
  observer: ((ended: EndedLease) => Observed) | undefined;

  leaseEnded(ended: EndedLease, signal: AbortSignal): Promise<void> {
    const observed = this.observer?.(ended);
    return new Promise<void>((resolve, reject) => {
      this.calls.push({
        abortedAtCall: signal.aborted,
        ended,
        observed,
        reject,
        resolve,
        signal,
      });
    });
  }
}

class ThrowingParticipant implements LeaseEndParticipant {
  leaseEnded(): Promise<void> {
    throw new Error("participant threw");
  }
}

interface World {
  readonly bus: EventBus;
  readonly clock: FakeClock;
  readonly driver: FakeDriver;
  readonly filesystem: MemoryFilesystem;
  readonly ids: { next: number };
  readonly sink: MemoryLogSink;
}

function createWorld(driverOptions: Partial<FakeDriverOptions> = {}): World {
  const clock = new FakeClock(1_000);
  return {
    bus: new EventBus(clock),
    clock,
    driver: new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      ...driverOptions,
    }),
    filesystem: new MemoryFilesystem(),
    ids: { next: 1 },
    sink: new MemoryLogSink(),
  };
}

interface EngineOptions {
  readonly ios?: { readonly maxDevices: number; readonly maxRunning: number };
  readonly lease?: Partial<Config["lease"]>;
  readonly participants?: readonly LeaseEndParticipant[];
  readonly world?: World;
}

function config(options: EngineOptions): Config {
  const ios = options.ios ?? { maxDevices: 1, maxRunning: 1 };
  return {
    capabilities: {},
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
      alerts: { destinations: [] },
    },
    drivers: {},
    downloads: { acceptAndroidLicenses: false, policy: "on-request", timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 1_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    android: {
      defaultModels: {},
      emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
    },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: PROBE_MS,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 48 * 60 * 60_000, shutdownAfterMs: 24 * 60 * 60_000 },
    lease: {
      defaultTtlMs: 3_600_000,
      maxTtlMs: 14_400_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: END_WAIT_MS,
      ...options.lease,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios,
          maxRunning: ios.maxRunning + 1,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: {
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    metrics: { retention: 90 * 24 * 60 * 60 * 1000 },
    warmPool: {
      enabled: true,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

interface Harness extends World {
  readonly engine: TestEngine;
  readonly registry: Registry;
  readonly world: World;
}

const started: TestEngine[] = [];

afterEach(() => {
  for (const engine of started.splice(0)) engine.dispose();
});

async function startEngine(options: EngineOptions = {}): Promise<Harness> {
  const world = options.world ?? createWorld();
  const { bus, clock, driver, filesystem, ids, sink } = world;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem,
    idGenerator: { generate: () => `${ids.next++}` },
    statePath,
  });
  const engine = createTestEngine({
    ...testComponentWiring({ clock, drivers: [driver], eventBus: bus, registry }),
    clock,
    config: config(options),
    drivers: [driver],
    eventBus: bus,
    idGenerator: { generate: () => `request-${ids.next++}` },
    ...(options.participants === undefined ? {} : { leaseEndParticipants: options.participants }),
    logger: new JsonLinesLogger({ clock, level: "debug", sink }),
    registry,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
  });
  started.push(engine);
  for (const participant of options.participants ?? []) {
    if (participant instanceof TestParticipant) {
      participant.observer = (ended) => {
        const device = registry.snapshot.devices.find(
          (candidate) => candidate.id === ended.deviceId,
        );
        return {
          claimed: engine.claimReader.isClaimed(ended.deviceId),
          deviceState: device?.state,
          events: bus.replay().map((event) => String(event.event)),
          leaseCount: registry.snapshot.leases.length,
          marker: (device as { deferredReclaimLeaseId?: string } | undefined)
            ?.deferredReclaimLeaseId,
        };
      };
    }
  }
  return { ...world, engine, registry, world };
}

function asking(requesterId: string) {
  return { ownerId: `${requesterId}-owner`, requesterId };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    await Promise.resolve();
  }
}

async function settledOrPending(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.catch((error: unknown) => error),
    flush().then(() => "still pending"),
  ]);
}

function reclaims(driver: FakeDriver) {
  return driver.calls.filter((call) => call.operation === "reclaim");
}

function stateOf(harness: Harness, deviceId: string): string | undefined {
  return harness.registry.snapshot.devices.find((device) => device.id === deviceId)?.state;
}

function markerOf(harness: Harness, deviceId: string): string | undefined {
  const device = harness.registry.snapshot.devices.find((candidate) => candidate.id === deviceId);
  return (device as { deferredReclaimLeaseId?: string } | undefined)?.deferredReclaimLeaseId;
}

function warningsFor(world: World, leaseId: string) {
  return world.sink.records.filter(
    (record) => record.level === "warn" && record.fields?.leaseId === leaseId,
  );
}

function errorsFor(world: World, leaseId: string) {
  return world.sink.records.filter(
    (record) => record.level === "error" && record.fields?.leaseId === leaseId,
  );
}

function eventNames(world: World): string[] {
  return world.bus.replay().map((event) => String(event.event));
}

async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  expect(seen).toEqual([]);
}

async function leaseAndRelease(options: EngineOptions = {}) {
  const participant = new TestParticipant();
  const harness = await startEngine({ participants: [participant], ...options });
  const grant = await harness.engine.request(request, asking("agent"));
  await harness.engine.release(grant.lease.id, "explicit");
  await flush();
  return { grant, harness, participant };
}

async function endStartupLease(options: {
  readonly afterFirstStop?: (first: Harness, grant: LeaseGrant) => void | Promise<void>;
  readonly participant: TestParticipant;
  readonly ttlMs?: number;
}) {
  const world = createWorld();
  const first = await startEngine({ world });
  const grant = await first.engine.request(request, {
    ...asking("agent"),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  first.engine.dispose();
  await options.afterFirstStop?.(first, grant);
  const second = await startEngine({ participants: [options.participant], world });
  return { grant, second, world };
}

function driverDeviceOf(harness: Harness, deviceId: string): DriverDevice {
  const device = harness.registry.snapshot.devices.find((candidate) => candidate.id === deviceId);
  if (device === undefined) throw new Error(`no device ${deviceId}`);
  return { address: "", deviceId: device.driverDeviceId, driverData: device.driverData };
}

describe("lease-end participants (#469)", () => {
  it("a release answers its caller while the participant has not returned, and the participant gets the lease id, owner, simlock device id, platform and reason explicit", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const grant = await harness.engine.request(request, asking("agent"));

    const released = harness.engine.release(grant.lease.id, "explicit");

    await expect(settledOrPending(released)).resolves.toBeUndefined();
    await flush();
    expect(participant.calls.map((call) => call.ended)).toEqual([
      {
        deviceId: grant.device.id,
        leaseId: grant.lease.id,
        ownerId: "agent-owner",
        platform: "ios",
        reason: "explicit",
      },
    ]);
  });

  it("the participant is called after lease.released is emitted, while the device is reclaiming and has no lease", async () => {
    const { grant, participant } = await leaseAndRelease();

    expect(participant.calls).toHaveLength(1);
    expect(participant.calls[0]?.observed).toMatchObject({
      deviceState: "reclaiming",
      leaseCount: 0,
    });
    expect(participant.calls[0]?.observed?.events).toContain("lease.released");
    expect(grant.device.id).toBe(participant.calls[0]?.ended.deviceId);
  });

  it("the driver's reclaim does not start until the participant returns; when it returns, the reclaim runs and the device becomes ready", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    expect(reclaims(harness.driver)).toHaveLength(0);
    expect(stateOf(harness, grant.device.id)).toBe("reclaiming");

    participant.calls[0]?.resolve();
    await flush();

    expect(reclaims(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, grant.device.id)).toBe("ready");
  });

  it("while the participant has not returned, a request for the same spec is not granted that device, and it is granted it after the reclaim", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    const second = harness.engine.request(request, asking("next"));

    await expect(settledOrPending(second)).resolves.toBe("still pending");
    participant.calls[0]?.resolve();
    await flush();
    await harness.engine.settle();
    await expect(settledOrPending(second)).resolves.toMatchObject({
      device: { id: grant.device.id },
    });
  });

  it("the device is claimed from before the participant is called until the reclaim ends", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    expect(participant.calls[0]?.observed?.claimed).toBe(true);
    expect(harness.engine.claimReader.isClaimed(grant.device.id)).toBe(true);
    participant.calls[0]?.resolve();
    await flush();
    await harness.engine.settle();
    expect(reclaims(harness.driver)).toHaveLength(1);
    expect(harness.engine.claimReader.isClaimed(grant.device.id)).toBe(false);
  });

  it("while the participant has not returned, a renew of another lease and a grant of another device both complete", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      ios: { maxDevices: 3, maxRunning: 3 },
      participants: [participant],
    });
    const ending = await harness.engine.request(request, asking("ending"));
    const other = await harness.engine.request(request, asking("other"));
    await harness.engine.release(ending.lease.id, "explicit");
    await flush();
    expect(participant.calls).toHaveLength(1);

    const renewed = harness.engine.renew(other.lease.id, 120_000);
    const granted = harness.engine.request(request, asking("third"));

    await expect(settledOrPending(renewed)).resolves.toMatchObject({ id: other.lease.id });
    const third = await settledOrPending(granted);
    expect(third).toMatchObject({ lease: { requesterId: "third" } });
    expect((third as LeaseGrant).device.id).not.toBe(ending.device.id);
  });

  it("a participant that never returns: 1 ms before lease.endWaitMs the reclaim has not started; at lease.endWaitMs its signal is aborted, a warning naming the lease and device is logged, and the reclaim starts; when that participant resolves later, the driver's reclaim has still run once", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS - 1);
    await flush();
    expect(reclaims(harness.driver)).toHaveLength(0);
    expect(participant.calls[0]?.signal.aborted).toBe(false);

    harness.clock.advance(1);
    await flush();
    expect(participant.calls[0]?.signal.aborted).toBe(true);
    expect(warningsFor(harness, grant.lease.id)).toMatchObject([
      { fields: { deviceId: grant.device.id, leaseId: grant.lease.id } },
    ]);
    expect(reclaims(harness.driver)).toHaveLength(1);

    participant.calls[0]?.resolve();
    await flush();
    expect(reclaims(harness.driver)).toHaveLength(1);
  });

  it("two participants are both called before either returns; the reclaim waits for the slower one", async () => {
    const fast = new TestParticipant();
    const slow = new TestParticipant();
    const harness = await startEngine({ participants: [fast, slow] });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(fast.calls).toHaveLength(1);
    expect(slow.calls).toHaveLength(1);

    fast.calls[0]?.resolve();
    await flush();
    expect(reclaims(harness.driver)).toHaveLength(0);

    slow.calls[0]?.resolve();
    await flush();
    expect(reclaims(harness.driver)).toHaveLength(1);
  });

  it("one ceiling, counted from the call, covers both participants and is not reset when the first returns", async () => {
    const fast = new TestParticipant();
    const slow = new TestParticipant();
    const harness = await startEngine({ participants: [fast, slow] });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(fast.calls).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS / 2);
    fast.calls[0]?.resolve();
    await flush();
    harness.clock.advance(END_WAIT_MS / 2 - 1);
    await flush();
    expect(reclaims(harness.driver)).toHaveLength(0);

    harness.clock.advance(1);
    await flush();
    expect(slow.calls[0]?.signal.aborted).toBe(true);
    expect(reclaims(harness.driver)).toHaveLength(1);
  });

  it("a participant that rejects, and one that throws, are each logged as an error with the lease id, device id and error message; the other participant is still awaited; the device becomes ready", async () => {
    const rejecting = new TestParticipant();
    const waiting = new TestParticipant();
    const harness = await startEngine({
      participants: [rejecting, new ThrowingParticipant(), waiting],
    });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(rejecting.calls).toHaveLength(1);
    expect(waiting.calls).toHaveLength(1);

    rejecting.calls[0]?.reject(new Error("participant rejected"));
    await flush();
    expect(reclaims(harness.driver)).toHaveLength(0);
    expect(errorsFor(harness, grant.lease.id)).toMatchObject([
      { fields: { deviceId: grant.device.id, error: "participant threw" } },
      { fields: { deviceId: grant.device.id, error: "participant rejected" } },
    ]);

    waiting.calls[0]?.resolve();
    await flush();
    expect(stateOf(harness, grant.device.id)).toBe("ready");
  });

  it("a participant that rejects after the ceiling passed is logged as an error with the lease id; the run reports no unhandled rejection", async () => {
    await withoutUnhandledRejections(async () => {
      const { grant, harness, participant } = await leaseAndRelease();
      expect(participant.calls).toHaveLength(1);
      harness.clock.advance(END_WAIT_MS);
      await flush();
      expect(reclaims(harness.driver)).toHaveLength(1);

      participant.calls[0]?.reject(new Error("rejected late"));
      await flush();

      expect(errorsFor(harness, grant.lease.id)).toMatchObject([
        { fields: { error: "rejected late" } },
      ]);
    });
  });

  it("a participant that rejects after nuke cut its wait short is logged as an error with the lease id; the run reports no unhandled rejection", async () => {
    await withoutUnhandledRejections(async () => {
      const { grant, harness, participant } = await leaseAndRelease();
      expect(participant.calls).toHaveLength(1);
      await harness.engine.nuke(false);

      participant.calls[0]?.reject(new Error("rejected after nuke"));
      await flush();

      expect(errorsFor(harness, grant.lease.id)).toMatchObject([
        { fields: { error: "rejected after nuke" } },
      ]);
    });
  });

  it("release with reason killed calls the participant with that reason before the reclaim", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const grant = await harness.engine.request(request, asking("agent"));

    await harness.engine.release(grant.lease.id, "killed");
    await flush();

    expect(participant.calls.map((call) => call.ended.reason)).toEqual(["killed"]);
    expect(reclaims(harness.driver)).toHaveLength(0);
  });

  it("releaseAll calls the participant once per lease, before any reclaim", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      ios: { maxDevices: 2, maxRunning: 2 },
      participants: [participant],
    });
    const first = await harness.engine.request(request, asking("one"));
    const second = await harness.engine.request(request, asking("two"));

    await harness.engine.releaseAll("explicit");
    await flush();

    expect(participant.calls.map((call) => call.ended.leaseId).sort()).toEqual(
      [first.lease.id, second.lease.id].sort(),
    );
    expect(reclaims(harness.driver)).toHaveLength(0);
  });

  it("an expiry calls the participant with reason expired before the reclaim", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ lease: { defaultTtlMs: 10 }, participants: [participant] });
    await harness.engine.request(request, asking("agent"));

    harness.clock.advance(10);
    await flush();

    expect(participant.calls.map((call) => call.ended.reason)).toEqual(["expired"]);
    expect(reclaims(harness.driver)).toHaveLength(0);
  });

  it("the health monitor's device-lost release calls the participant with reason device-lost before the reclaim", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    await harness.engine.request(request, asking("agent"));
    harness.driver.setManagedReality({ devices: [], processes: [] });

    harness.engine.healthMonitor.start();
    for (let tick = 0; tick < 3; tick += 1) {
      harness.clock.advance(PROBE_MS);
      await flush();
    }
    harness.engine.healthMonitor.dispose();

    expect(participant.calls.map((call) => call.ended.reason)).toEqual(["device-lost"]);
    expect(reclaims(harness.driver)).toHaveLength(0);
  });

  it.each([
    ["expired", 10_000],
    ["device-lost", 3_600_000],
  ] as const)(
    "a startup ending with reclaim calls the participant with reason %s before the reclaim",
    async (reason, ttlMs) => {
      const participant = new TestParticipant();
      const { grant, second, world } = await endStartupLease({
        afterFirstStop: async (first, leased) => {
          await first.driver.shutdown(driverDeviceOf(first, leased.device.id));
          first.clock.advance(20_000);
        },
        participant,
        ttlMs,
      });

      await second.engine.convergeRunningCapacity();
      await flush();

      expect(participant.calls.map((call) => call.ended)).toMatchObject([
        { deviceId: grant.device.id, leaseId: grant.lease.id, reason },
      ]);
      expect(reclaims(world.driver)).toHaveLength(0);
    },
  );

  it("a startup ending with reclaim whose participant has not returned, followed by core.converge: converge leaves the device alone, and the device is wiped once the participant returns", async () => {
    const participant = new TestParticipant();
    const { grant, second, world } = await endStartupLease({
      afterFirstStop: async (first, leased) => {
        await first.driver.shutdown(driverDeviceOf(first, leased.device.id));
      },
      participant,
    });
    const callsBefore = world.driver.calls.length;

    await second.engine.convergeRunningCapacity();
    await flush();

    expect(participant.calls).toHaveLength(1);
    expect(
      world.driver.calls.slice(callsBefore).filter((call) => call.operation === "shutdown"),
    ).toEqual([]);
    expect(
      world.bus
        .replay()
        .filter(
          (event) =>
            String(event.event) === "device.shutdown" &&
            (event.payload as { initiator?: string }).initiator === "startup-interrupted-reclaim",
        ),
    ).toEqual([]);
    expect(reclaims(world.driver)).toHaveLength(0);

    participant.calls[0]?.resolve();
    await flush();
    await second.engine.settle();
    expect(reclaims(world.driver)).toHaveLength(1);
    expect(stateOf(second, grant.device.id)).toBe("ready");
  });

  it("a startup ending with wait calls the participant with its reason, starts no reclaim, and leaves the device reclaiming with its deferred wipe recorded", async () => {
    const participant = new TestParticipant();
    const { grant, second, world } = await endStartupLease({
      afterFirstStop: (first) => {
        first.driver.failOn(
          "listManaged",
          first.driver.calls.filter((call) => call.operation === "listManaged").length + 1,
          new Error("cannot list"),
        );
      },
      participant,
    });

    await second.engine.convergeRunningCapacity();
    await flush();
    participant.calls[0]?.resolve();
    await flush();

    expect(participant.calls.map((call) => call.ended)).toMatchObject([
      { deviceId: grant.device.id, leaseId: grant.lease.id, reason: "device-lost" },
    ]);
    expect(reclaims(world.driver)).toHaveLength(0);
    expect(stateOf(second, grant.device.id)).toBe("reclaiming");
    expect(markerOf(second, grant.device.id)).toBe(grant.lease.id);
  });

  it("a startup ending with missing calls the participant and marks the device missing, without waiting for it", async () => {
    const participant = new TestParticipant();
    const { grant, second } = await endStartupLease({
      afterFirstStop: (first) => {
        first.driver.setManagedReality({ devices: [], processes: [] });
      },
      participant,
    });

    await expect(
      settledOrPending(second.engine.convergeRunningCapacity()),
    ).resolves.toBeUndefined();

    expect(participant.calls.map((call) => call.ended)).toMatchObject([
      { deviceId: grant.device.id, leaseId: grant.lease.id, reason: "device-lost" },
    ]);
    expect(stateOf(second, grant.device.id)).toBe("deleted");
    expect(second.registry.snapshot.leases).toEqual([]);
  });

  it("a physical device that goes absent (through PhysicalDeviceWatcher) calls the participant with device-lost, and the device becomes absent without waiting for it", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const device = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-A",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    harness.driver.setPhysicalPresence("UDID-A", true);
    (
      harness.engine.leasing as unknown as { physicalDeviceWatcher: { start(): void } }
    ).physicalDeviceWatcher.start();
    await harness.engine.request(physicalRequest, asking("agent"));

    harness.driver.setPhysicalPresence("UDID-A", false);
    for (let tick = 0; tick < 3; tick += 1) {
      harness.clock.advance(PROBE_MS);
      await flush();
    }

    expect(participant.calls.map((call) => call.ended)).toMatchObject([
      { deviceId: device.id, platform: "ios", reason: "device-lost" },
    ]);
    expect(stateOf(harness, device.id)).toBe("absent");
  });

  it("a call nothing waits for, still running at the ceiling, has its signal aborted then", async () => {
    const participant = new TestParticipant();
    const { second } = await endStartupLease({
      afterFirstStop: (first) => {
        first.driver.failOn(
          "listManaged",
          first.driver.calls.filter((call) => call.operation === "listManaged").length + 1,
          new Error("cannot list"),
        );
      },
      participant,
    });
    await second.engine.convergeRunningCapacity();
    await flush();
    expect(participant.calls).toHaveLength(1);

    second.clock.advance(END_WAIT_MS - 1);
    await flush();
    expect(participant.calls[0]?.signal.aborted).toBe(false);

    second.clock.advance(1);
    await flush();
    expect(participant.calls[0]?.signal.aborted).toBe(true);
  });

  it("a call nothing waits for that rejects is logged as an error with the lease id", async () => {
    await withoutUnhandledRejections(async () => {
      const participant = new TestParticipant();
      const { grant, second, world } = await endStartupLease({
        afterFirstStop: (first) => {
          first.driver.failOn(
            "listManaged",
            first.driver.calls.filter((call) => call.operation === "listManaged").length + 1,
            new Error("cannot list"),
          );
        },
        participant,
      });
      await second.engine.convergeRunningCapacity();
      await flush();
      expect(participant.calls).toHaveLength(1);

      participant.calls[0]?.reject(new Error("rejected unwaited"));
      await flush();

      expect(errorsFor(world, grant.lease.id)).toMatchObject([
        { fields: { error: "rejected unwaited" } },
      ]);
    });
  });

  it("a release of an unknown lease calls no participant", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    await harness.engine.request(request, asking("agent"));

    await expect(harness.engine.release("no-such-lease", "explicit")).rejects.toBeInstanceOf(
      UnknownLeaseError,
    );
    await flush();

    expect(participant.calls).toEqual([]);
  });

  it("an expiry whose deadline was moved by a renew calls no participant", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      lease: { defaultTtlMs: 100 },
      participants: [participant],
    });
    const grant = await harness.engine.request(request, asking("agent"));
    harness.clock.advance(90);
    await harness.engine.renew(grant.lease.id, 100);

    harness.clock.advance(20);
    await flush();

    expect(harness.registry.snapshot.leases).toHaveLength(1);
    expect(participant.calls).toEqual([]);
  });

  it.each([
    ["nuke", (harness: Harness) => harness.engine.nuke(false), { releasedLeaseIds: [] }],
    ["settle()", (harness: Harness) => harness.engine.settle(), undefined],
  ] as const)(
    "%s while a participant has not returned aborts its signal, starts the reclaim at once, and completes without the clock advancing",
    async (_call, run, completed) => {
      const { harness, participant } = await leaseAndRelease();
      expect(participant.calls).toHaveLength(1);

      const running = run(harness);

      await expect(settledOrPending(running)).resolves.toEqual(completed);
      expect(participant.calls[0]?.signal.aborted).toBe(true);
      expect(reclaims(harness.driver)).toHaveLength(1);
    },
  );

  it("advancing the clock past lease.endWaitMs after a nuke cut a wait short, and the participant then resolving, logs no ceiling warning and starts no second reclaim", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    await harness.engine.nuke(false);
    expect(reclaims(harness.driver)).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS + 1);
    participant.calls[0]?.resolve();
    await flush();

    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
    expect(reclaims(harness.driver)).toHaveLength(1);
  });

  it("nuke with leased devices calls each participant with an already aborted signal, and completes without the clock advancing even when the participant never returns", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      ios: { maxDevices: 2, maxRunning: 2 },
      participants: [participant],
    });
    const one = await harness.engine.request(request, asking("one"));
    const two = await harness.engine.request(request, asking("two"));

    const nuking = harness.engine.nuke(false);

    await expect(settledOrPending(nuking)).resolves.toMatchObject({
      releasedLeaseIds: expect.arrayContaining([one.lease.id, two.lease.id]),
    });
    expect(participant.calls.map((call) => call.abortedAtCall)).toEqual([true, true]);
  });

  it("advancing the clock past lease.endWaitMs after a nuke with leased devices logs no ceiling warning", async () => {
    const { grant, harness, participant } = await (async () => {
      const participant = new TestParticipant();
      const harness = await startEngine({ participants: [participant] });
      const grant = await harness.engine.request(request, asking("agent"));
      await harness.engine.nuke(false);
      return { grant, harness, participant };
    })();
    expect(participant.calls).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS + 1);
    await flush();

    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
  });

  it("after nuke ends, a release waits for its participant again", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    await harness.engine.nuke(false);
    const grant = await harness.engine.request(request, asking("agent"));

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    expect(participant.calls).toHaveLength(1);
    expect(participant.calls[0]?.abortedAtCall).toBe(false);
    expect(reclaims(harness.driver)).toHaveLength(0);
  });

  it("when the participant resolves after settle(), the driver's reclaim has run once, and advancing past lease.endWaitMs logs no ceiling warning", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    await harness.engine.settle();

    participant.calls[0]?.resolve();
    harness.clock.advance(END_WAIT_MS + 1);
    await flush();

    expect(reclaims(harness.driver)).toHaveLength(1);
    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
  });

  it("a release after settle() began calls the participant with an already aborted signal and reclaims at once", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.settle();

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    expect(participant.calls.map((call) => call.abortedAtCall)).toEqual([true]);
    expect(reclaims(harness.driver)).toHaveLength(1);
  });

  it("a participant that returns before the ceiling: advancing the clock past lease.endWaitMs afterwards logs no ceiling warning and aborts no signal", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    participant.calls[0]?.resolve();
    await flush();

    harness.clock.advance(END_WAIT_MS + 1);
    await flush();

    expect(reclaims(harness.driver)).toHaveLength(1);
    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
    expect(participant.calls[0]?.signal.aborted).toBe(false);
  });

  it("dispose() with a participant still running aborts its signal; advancing the clock past lease.endWaitMs afterwards, and the participant then resolving, logs no ceiling warning and starts no reclaim", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    harness.engine.dispose();
    expect(participant.calls[0]?.signal.aborted).toBe(true);
    harness.clock.advance(END_WAIT_MS + 1);
    participant.calls[0]?.resolve();
    await flush();

    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
    expect(reclaims(harness.driver)).toEqual([]);
  });

  it("with no participant, the reclaim starts without the clock advancing and the device record carries no deferred-reclaim marker", async () => {
    const world = createWorld({ latencyMs: { reclaim: 20 } });
    const harness = await startEngine({ world });
    const grant = await harness.engine.request(request, asking("agent"));

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    expect(reclaims(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, grant.device.id)).toBe("reclaiming");
    expect(markerOf(harness, grant.device.id)).toBeUndefined();
  });

  it("with a participant, the device is reclaiming with its deferred-reclaim marker while the participant runs, and the marker is gone once the device is ready", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    expect(stateOf(harness, grant.device.id)).toBe("reclaiming");
    expect(markerOf(harness, grant.device.id)).toBe(grant.lease.id);

    participant.calls[0]?.resolve();
    await flush();

    expect(stateOf(harness, grant.device.id)).toBe("ready");
    expect(markerOf(harness, grant.device.id)).toBeUndefined();
  });

  it("with running capacity full, while a participant waits, a lease request for another spec queues, and a noWait request gets NO_CAPACITY; the queued one is granted once the wait and the wipe end", async () => {
    const { harness, participant } = await leaseAndRelease({
      ios: { maxDevices: 2, maxRunning: 1 },
    });
    expect(participant.calls).toHaveLength(1);

    const queued = harness.engine.request(otherRequest, asking("queued"));
    const refused = harness.engine.request(otherRequest, { ...asking("hurried"), noWait: true });

    await expect(refused).rejects.toBeInstanceOf(NoCapacityError);
    await expect(settledOrPending(queued)).resolves.toBe("still pending");
    participant.calls[0]?.resolve();
    await flush();
    await harness.engine.settle();
    await expect(settledOrPending(queued)).resolves.toMatchObject({
      lease: { requesterId: "queued" },
    });
  });

  it("a daemon stopped while a participant has not returned: a new engine on the same registry runs the full wipe, the device becomes ready, and no participant registered in the new engine is called", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    const replacement = new TestParticipant();

    const restarted = await startEngine({ participants: [replacement], world: harness.world });
    await restarted.engine.convergeRunningCapacity();
    await flush();
    await restarted.engine.settle();

    expect(reclaims(harness.driver)).toMatchObject([
      { arguments: [expect.anything(), { clean: "standard" }] },
    ]);
    expect(stateOf(restarted, grant.device.id)).toBe("ready");
    expect(replacement.calls).toEqual([]);
  });

  it("a daemon stopped during the wipe that follows the wait also gets a full wipe at the next start", async () => {
    const world = createWorld({ latencyMs: { reclaim: 20 } });
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant], world });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(participant.calls).toHaveLength(1);
    participant.calls[0]?.resolve();
    await flush();
    expect(reclaims(world.driver)).toHaveLength(1);
    const wipesBefore = reclaims(world.driver).length;

    const restarted = await startEngine({ world });
    await restarted.engine.convergeRunningCapacity();
    await flush();

    expect(reclaims(world.driver).length - wipesBefore).toBe(1);
    expect(reclaims(world.driver).at(-1)).toMatchObject({
      arguments: [expect.anything(), { clean: "standard" }],
    });
  });

  it("a release with a participant emits the same events in the same order as one without (lease.released, then device.reclaimed)", async () => {
    const plain = await startEngine();
    const plainGrant = await plain.engine.request(request, asking("agent"));
    const plainBefore = eventNames(plain).length;
    await plain.engine.release(plainGrant.lease.id, "explicit");
    await flush();
    await plain.engine.settle();

    const participant = new TestParticipant();
    const waiting = await startEngine({ participants: [participant] });
    const waitingGrant = await waiting.engine.request(request, asking("agent"));
    const waitingBefore = eventNames(waiting).length;
    await waiting.engine.release(waitingGrant.lease.id, "explicit");
    await flush();
    expect(participant.calls).toHaveLength(1);
    participant.calls[0]?.resolve();
    await flush();
    await waiting.engine.settle();

    const expected = eventNames(plain).slice(plainBefore);
    expect(expected.indexOf("lease.released")).toBeLessThan(expected.indexOf("device.reclaimed"));
    expect(eventNames(waiting).slice(waitingBefore)).toEqual(expected);
  });
});
