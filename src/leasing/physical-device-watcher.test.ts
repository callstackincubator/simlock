import { afterEach, describe, expect, it, vi } from "vitest";
import * as coreModule from "../core/index.js";
import {
  type Config,
  type DeviceRequest,
  type LeaseGrant,
  type PhysicalDevice,
  Registry,
} from "../core/index.js";
import { FakeDriver, testComponentWiring } from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { createTestEngine, type TestEngine } from "./testing.js";

const latestPresence = (driverDeviceId: string): unknown =>
  (coreModule as unknown as Record<string, (id: string) => unknown>)["latestPresence"]?.(
    driverDeviceId,
  );

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const PROBE_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;

const physicalRequest = {
  model: "iPhone 15 Pro",
  physical: true,
  platform: "ios",
} as const satisfies DeviceRequest;

interface HarnessOptions {
  readonly android?: boolean;
  readonly health?: Partial<Config["health"]>;
  readonly logger?: Logger;
  readonly quarantineBackoffMs?: number;
}

function config(options: HarnessOptions): Config {
  const quarantineBackoffMs = options.quarantineBackoffMs ?? 30_000;
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
      ...options.health,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: {
      defaultTtlMs: 3_600_000,
      maxTtlMs: 14_400_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: 600_000,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
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
      enabled: false,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: Math.max(300_000, quarantineBackoffMs),
        retryBackoffMs: quarantineBackoffMs,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

interface Harness {
  readonly androidDriver: FakeDriver;
  readonly bus: EventBus;
  readonly clock: FakeClock;
  readonly driver: FakeDriver;
  readonly engine: TestEngine;
  readonly filesystem: MemoryFilesystem;
  readonly registry: Registry;
}

const harnesses: Harness[] = [];

async function createHarness(
  options: HarnessOptions = {},
  filesystem: MemoryFilesystem = new MemoryFilesystem(),
): Promise<Harness> {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const androidDriver = new FakeDriver({
    availableOsVersions: ["14"],
    clock,
    platform: "android",
  });
  const drivers = options.android === true ? [driver, androidDriver] : [driver];
  let nextId = 1;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const wiring = testComponentWiring({ clock, drivers, eventBus: bus, registry });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config: config(options),
    drivers,
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
  });
  const harness = { androidDriver, bus, clock, driver, engine, filesystem, registry };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    watcherOf(harness)?.dispose();
    harness.engine.dispose();
  }
});

interface WatcherHandle {
  start(): void;
  dispose(): void;
}

function watcherOf(harness: Harness): WatcherHandle | undefined {
  return (harness.engine.leasing as unknown as { physicalDeviceWatcher?: WatcherHandle })
    .physicalDeviceWatcher;
}

function startWatcher(harness: Harness): void {
  watcherOf(harness)?.start();
}

async function reopen(
  first: Harness,
  patch: (records: Record<string, unknown>[]) => void,
  options: HarnessOptions = {},
): Promise<Harness> {
  const raw = JSON.parse(await first.filesystem.readFile(statePath)) as {
    physicalDevices: Record<string, unknown>[];
  };
  patch(raw.physicalDevices);
  await first.filesystem.writeFileAtomic(statePath, JSON.stringify(raw));
  first.engine.dispose();
  return createHarness(options, first.filesystem);
}

function markAbsent(
  records: Record<string, unknown>[],
  driverDeviceId: string,
  absentReason: string,
): void {
  const record = records.find((candidate) => candidate.driverDeviceId === driverDeviceId);
  if (record === undefined) throw new Error(`no record for ${driverDeviceId}`);
  record.state = "absent";
  record.absentReason = absentReason;
}

async function enrollIphone(harness: Harness, driverDeviceId: string): Promise<PhysicalDevice> {
  const device = await harness.registry.enrollPhysical({
    apps: [],
    class: "phone",
    driverDeviceId,
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    platform: "ios",
  });
  harness.driver.setPhysicalPresence(driverDeviceId, true);
  return device;
}

async function absentHarness(
  reason: string,
  options: HarnessOptions = {},
): Promise<{ readonly device: PhysicalDevice; readonly harness: Harness }> {
  const first = await createHarness(options);
  const device = await enrollIphone(first, "UDID-A");
  const harness = await reopen(first, (records) => markAbsent(records, "UDID-A", reason), options);
  return { device, harness };
}

function asking(requesterId: string) {
  return { ownerId: requesterId, requesterId };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    await Promise.resolve();
  }
}

async function tick(harness: Harness, times = 1): Promise<void> {
  for (let count = 0; count < times; count += 1) {
    harness.clock.advance(PROBE_MS);
    await flush();
  }
}

async function outcome(promise: Promise<LeaseGrant>): Promise<LeaseGrant | Error | "pending"> {
  return Promise.race([
    promise.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    flush().then(() => "pending" as const),
  ]);
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), flush().then(() => false)]);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gone(
  harness: Harness,
  driverDeviceId: string,
  reason?: "locked" | "untrusted" | "not-present",
): void {
  harness.driver.setPhysicalPresence(driverDeviceId, false, reason === undefined ? {} : { reason });
}

function back(harness: Harness, driverDeviceId: string): void {
  harness.driver.setPhysicalPresence(driverDeviceId, true);
}

function stateOf(harness: Harness, device: PhysicalDevice): string | undefined {
  return harness.registry.snapshot.devices.find((candidate) => candidate.id === device.id)?.state;
}

function absentReasonOf(harness: Harness, device: PhysicalDevice): unknown {
  const record = harness.registry.snapshot.devices.find((candidate) => candidate.id === device.id);
  return (record as unknown as Record<string, unknown> | undefined)?.absentReason;
}

function eventsOf(harness: Harness, name: string) {
  return harness.bus.replay().filter((event) => String(event.event) === name);
}

function readsOf(driver: FakeDriver): unknown[] {
  return driver.calls
    .filter((call) => call.operation === "listPresentPhysical")
    .map((call) => call.arguments[0]);
}

const heldReclaims = new WeakMap<FakeDriver, number>();

function reclaimCalls(driver: FakeDriver) {
  const held = Array.from({ length: heldReclaims.get(driver) ?? 0 }, () => ({
    arguments: [] as unknown[],
    operation: "reclaim" as const,
  }));
  return [...driver.calls.filter((call) => call.operation === "reclaim"), ...held];
}

type PresenceAnswer = Awaited<ReturnType<FakeDriver["listPresentPhysical"]>>;

function answer(
  entries: readonly {
    readonly driverDeviceId: string;
    readonly present: boolean;
    readonly osVersion?: string;
    readonly reason?: string;
  }[],
): PresenceAnswer {
  return entries as unknown as PresenceAnswer;
}

interface RecordedWrite {
  readonly claims: Record<string, string | undefined>;
  readonly states: Record<string, string>;
}

function recordStateWrites(harness: Harness): RecordedWrite[] {
  const writes: RecordedWrite[] = [];
  const original = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
  vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(
    async (path, contents, options) => {
      if (path === statePath) {
        const parsed = JSON.parse(contents) as {
          devices?: { id: string; state: string }[];
          physicalDevices?: { id: string; state: string }[];
        };
        const records = [...(parsed.devices ?? []), ...(parsed.physicalDevices ?? [])];
        writes.push({
          claims: Object.fromEntries(
            records.map((record) => [record.id, harness.engine.core.claims.claim(record.id)?.kind]),
          ),
          states: Object.fromEntries(records.map((record) => [record.id, record.state])),
        });
      }
      return original(path, contents, options);
    },
  );
  return writes;
}

function holdNextReclaim(harness: Harness): { readonly resolve: () => void } {
  const gate = deferred();
  const original = harness.driver.reclaim.bind(harness.driver);
  vi.spyOn(harness.driver, "reclaim").mockImplementationOnce(async (device, options) => {
    heldReclaims.set(harness.driver, (heldReclaims.get(harness.driver) ?? 0) + 1);
    await gate.promise;
    heldReclaims.set(harness.driver, (heldReclaims.get(harness.driver) ?? 1) - 1);
    return original(device, options);
  });
  return gate;
}

function capturingLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }), sink };
}

async function oneNotPresentReadThenReady(
  options: { readonly failFirstReclaim: boolean } = { failFirstReclaim: false },
) {
  const harness = await createHarness({ quarantineBackoffMs: 10_000 });
  const device = await enrollIphone(harness, "UDID-A");
  startWatcher(harness);
  gone(harness, "UDID-A");
  await tick(harness);
  expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
  back(harness, "UDID-A");
  if (options.failFirstReclaim) harness.driver.failOn("reclaim", 1, new Error("uninstall failed"));
  const grant = await harness.engine.request(physicalRequest, asking("agent"));
  await harness.engine.release(grant.lease.id, "explicit");
  await flush();
  return { device, harness };
}

describe("PhysicalDeviceWatcher counting", () => {
  it("a present read between not-present reads sets the count back to 0", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);

    gone(harness, "UDID-A");
    await tick(harness);
    back(harness, "UDID-A");
    await tick(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a read that takes longer than health.probeIntervalMs delays the next tick, and no two reads of one platform overlap", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    harness.driver.holdPresenceReads("UDID-A");
    startWatcher(harness);

    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);

    for (let count = 0; count < 3; count += 1) {
      harness.clock.advance(PROBE_MS);
      await flush();
    }
    expect(readsOf(harness.driver)).toHaveLength(1);

    harness.driver.releasePresenceReads();
    await flush();
    harness.clock.advance(PROBE_MS - 1);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(1);

    harness.clock.advance(1);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(2);
  });

  it("each read asks the driver only for the canonical IDs of that platform's enrolled records, deleted ones left out", async () => {
    const harness = await createHarness({ android: true });
    await enrollIphone(harness, "UDID-A");
    const removed = await enrollIphone(harness, "UDID-B");
    await harness.registry.unenrollPhysical(removed.id);
    await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "EMU-1",
      model: "Pixel 8",
      osVersion: "14",
      platform: "android",
    });
    harness.androidDriver.setPhysicalPresence("EMU-1", true);
    startWatcher(harness);

    await tick(harness);

    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(readsOf(harness.androidDriver)).toEqual([["EMU-1"]]);
  });

  it("a read that rejects changes neither the count nor the state of that platform's devices", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.failOn("listPresentPhysical", 2, new Error("devicectl: timed out"));
    startWatcher(harness);
    gone(harness, "UDID-A");

    await tick(harness);
    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(2);
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a device with no entry in the driver's answer counts as not present, with reason not-present", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    vi.spyOn(harness.driver, "listPresentPhysical").mockResolvedValue(answer([]));
    startWatcher(harness);

    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);

    expect(stateOf(harness, device)).toBe("absent");
    expect(absentReasonOf(harness, device)).toBe("not-present");
  });

  it("a device read not present locked and then not-present becomes absent with the last read's reason", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);

    gone(harness, "UDID-A", "locked");
    await tick(harness);
    gone(harness, "UDID-A", "not-present");
    await tick(harness);

    expect(stateOf(harness, device)).toBe("absent");
    expect(absentReasonOf(harness, device)).toBe("not-present");
  });

  it("a device with one not-present read that then enters ready (through a reclaim, a quarantine recovery, or device add) starts its count at 0: one more not-present read leaves it ready", async () => {
    const reclaimed = await oneNotPresentReadThenReady();
    expect(stateOf(reclaimed.harness, reclaimed.device)).toBe("ready");
    gone(reclaimed.harness, "UDID-A");
    await tick(reclaimed.harness);
    expect(stateOf(reclaimed.harness, reclaimed.device)).toBe("ready");
    await tick(reclaimed.harness);
    expect(stateOf(reclaimed.harness, reclaimed.device)).toBe("absent");

    const recovered = await oneNotPresentReadThenReady({ failFirstReclaim: true });
    expect(stateOf(recovered.harness, recovered.device)).toBe("quarantined");
    recovered.harness.clock.advance(10_000);
    await flush();
    expect(stateOf(recovered.harness, recovered.device)).toBe("ready");
    gone(recovered.harness, "UDID-A");
    await tick(recovered.harness);
    expect(stateOf(recovered.harness, recovered.device)).toBe("ready");
    await tick(recovered.harness);
    expect(stateOf(recovered.harness, recovered.device)).toBe("absent");

    const added = await oneNotPresentReadThenReady({ failFirstReclaim: true });
    expect(stateOf(added.harness, added.device)).toBe("quarantined");
    added.harness.driver.setPhysicalDevices([{ ids: ["UDID-A"], model: "iPhone 15 Pro" }]);
    await added.harness.engine.core.enrollment.add("ios", "UDID-A");
    expect(stateOf(added.harness, added.device)).toBe("ready");
    gone(added.harness, "UDID-A");
    await tick(added.harness);
    expect(stateOf(added.harness, added.device)).toBe("ready");
    await tick(added.harness);
    expect(stateOf(added.harness, added.device)).toBe("absent");
  });

  it("a tick whose read starts before a reclaim commits ready, and resolves not present after that commit, does not count that read: with health.stableObservations 2, one more not-present read leaves the device ready", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    const grant = await harness.engine.request(physicalRequest, asking("agent"));
    harness.driver.holdPresenceReads("UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(2);
    const reclaim = holdNextReclaim(harness);
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(stateOf(harness, device)).toBe("reclaiming");
    reclaim.resolve();
    await flush();
    expect(stateOf(harness, device)).toBe("ready");
    gone(harness, "UDID-A");
    harness.driver.releasePresenceReads();
    await flush();
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a read begun while a device was ready, that resolves not present after the device is re-enrolled, does not count: with health.stableObservations 2, one more not-present read leaves it ready", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    harness.driver.holdPresenceReads("UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(2);
    harness.driver.setPhysicalDevices([{ ids: ["UDID-A"], model: "iPhone 15 Pro" }]);
    await harness.engine.core.enrollment.add("ios", "UDID-A");

    harness.driver.releasePresenceReads();
    await flush();
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("starting the watcher twice arms one timer: one health.probeIntervalMs later the platform has been read once", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    startWatcher(harness);

    await tick(harness);

    expect(readsOf(harness.driver)).toHaveLength(1);
  });

  it("a watcher started after it was disposed reads nothing", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    watcherOf(harness)?.dispose();
    startWatcher(harness);

    await tick(harness, 3);

    expect(readsOf(harness.driver)).toEqual([]);
  });

  it("no device action is attempted when a read rejects", async () => {
    const harness = await createHarness({ health: { stableObservations: 1 } });
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    harness.driver.failOn("listPresentPhysical", 1, new Error("devicectl: timed out"));
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness);

    expect(readsOf(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, device)).toBe("ready");
    expect(writes).toHaveLength(0);
  });

  it("a tick that throws outside any device action still arms the next tick", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const original = Object.getOwnPropertyDescriptor(Registry.prototype, "snapshot")?.get;
    let thrown = false;
    const spy = vi
      .spyOn(harness.registry, "snapshot", "get")
      .mockImplementation(function (this: Registry) {
        if (!thrown && new Error().stack?.includes("physical-device-watcher.ts:") === true) {
          thrown = true;
          throw new Error("snapshot unavailable");
        }
        return original?.call(this) as never;
      });
    startWatcher(harness);

    await tick(harness);
    spy.mockRestore();

    expect(thrown).toBe(true);
    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });
});

describe("PhysicalDeviceWatcher acting on a device", () => {
  it("an absent device read not present with another reason gets its absentReason rewritten in one registry write, with no event; a read with the same reason writes nothing", async () => {
    const { device, harness } = await absentHarness("locked");
    gone(harness, "UDID-A", "locked");
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(writes).toHaveLength(0);
    expect(absentReasonOf(harness, device)).toBe("locked");

    gone(harness, "UDID-A", "not-present");
    const eventsBefore = harness.bus.replay().length;
    await tick(harness);
    expect(absentReasonOf(harness, device)).toBe("not-present");
    expect(writes).toHaveLength(1);
    expect(harness.bus.replay()).toHaveLength(eventsBefore);

    await tick(harness);
    expect(writes).toHaveLength(1);
    expect(absentReasonOf(harness, device)).toBe("not-present");
  });

  it("a device under an operation claim read not present past the grace period keeps its state; the first tick after the claim is released moves it", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const claim = harness.engine.core.claims.tryClaim(device.id, "enrollment");
    expect(claim).toBeDefined();
    startWatcher(harness);

    await tick(harness, 3);
    expect(readsOf(harness.driver)).toHaveLength(3);
    expect(stateOf(harness, device)).toBe("ready");

    claim?.release();
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a grant that commits between the watcher's read and its write leaves the new lease in place", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);

    back(harness, "UDID-A");
    const gate = deferred();
    vi.spyOn(harness.driver, "listPresentPhysical").mockImplementationOnce(async (ids) => {
      await gate.promise;
      return answer(
        ids.map((driverDeviceId) => ({ driverDeviceId, present: false, reason: "not-present" })),
      );
    });
    harness.clock.advance(PROBE_MS);
    await flush();
    const granted = await outcome(harness.engine.request(physicalRequest, asking("agent")));
    expect(granted).toMatchObject({ device: { id: device.id } });
    gate.resolve();
    await flush();

    expect(stateOf(harness, device)).toBe("leased");
    expect(harness.registry.snapshot.leases).toMatchObject([{ deviceId: device.id }]);
    expect(eventsOf(harness, "lease.released")).toEqual([]);
  });

  it("the return reclaim holds a reclaim claim from before the absent → reclaiming write until it settles, and releases it when the reclaim throws", async () => {
    const held = await absentHarness("not-present");
    back(held.harness, "UDID-A");
    const writes = recordStateWrites(held.harness);
    const gate = holdNextReclaim(held.harness);
    startWatcher(held.harness);

    await tick(held.harness);
    expect(reclaimCalls(held.harness.driver)).toHaveLength(1);
    expect(held.harness.engine.core.claims.claim(held.device.id)?.kind).toBe("reclaim");
    expect(stateOf(held.harness, held.device)).toBe("reclaiming");
    expect(writes.find((write) => write.states[held.device.id] === "reclaiming")).toMatchObject({
      claims: { [held.device.id]: "reclaim" },
    });
    gate.resolve();
    await flush();
    expect(held.harness.engine.core.claims.isClaimed(held.device.id)).toBe(false);
    expect(stateOf(held.harness, held.device)).toBe("ready");

    const thrown = await absentHarness("not-present");
    back(thrown.harness, "UDID-A");
    thrown.harness.driver.failOn("reclaim", 1, new Error("usb dropped"));
    startWatcher(thrown.harness);

    await tick(thrown.harness);
    expect(reclaimCalls(thrown.harness.driver)).toHaveLength(1);
    expect(thrown.harness.engine.core.claims.isClaimed(thrown.device.id)).toBe(false);
  });

  it("an absent device read present while device add holds its claim gets no write and no reclaim that tick", async () => {
    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    const claim = harness.engine.core.claims.tryClaim(device.id, "enrollment");
    expect(claim).toBeDefined();
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(writes).toHaveLength(0);
    expect(reclaimCalls(harness.driver)).toHaveLength(0);
    expect(stateOf(harness, device)).toBe("absent");

    claim?.release();
    await tick(harness);
    expect(reclaimCalls(harness.driver)).toHaveLength(1);
  });

  it("an absent device read present is returned and reclaimed on that tick, at most one health.probeIntervalMs after it was scripted present", async () => {
    const { device, harness } = await absentHarness("not-present");
    startWatcher(harness);
    harness.clock.advance(10_000);
    await flush();

    back(harness, "UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();

    expect(eventsOf(harness, "device.returned")).toHaveLength(1);
    expect(reclaimCalls(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, device)).toBe("ready");
  });

  it("a device the fake driver reports present again has a latest read of present within one health.probeIntervalMs", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-LATEST-WATCH");
    startWatcher(harness);
    gone(harness, "UDID-LATEST-WATCH", "locked");
    await tick(harness);
    expect(latestPresence("UDID-LATEST-WATCH")).toStrictEqual({ present: false, reason: "locked" });

    back(harness, "UDID-LATEST-WATCH");
    harness.clock.advance(PROBE_MS);
    await flush();

    expect(latestPresence("UDID-LATEST-WATCH")).toStrictEqual({ present: true });
  });

  it("two ready devices read not present for the grace period both become absent, each judged on its own state", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    gone(harness, "UDID-A", "locked");
    gone(harness, "UDID-B", "untrusted");
    startWatcher(harness);

    await tick(harness, 2);

    expect([stateOf(harness, first), stateOf(harness, second)]).toEqual(["absent", "absent"]);
    expect([absentReasonOf(harness, first), absentReasonOf(harness, second)]).toEqual([
      "locked",
      "untrusted",
    ]);
  });

  it("a tick where one device's action throws (its registry write fails) logs it, still acts on the other devices, and arms the next tick; that device's count is not reset, so the next not-present read acts on it again", async () => {
    const { logger, sink } = capturingLogger();
    const harness = await createHarness({ logger });
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    gone(harness, "UDID-A");
    gone(harness, "UDID-B");
    startWatcher(harness);
    await tick(harness);
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const problems = () =>
      sink.records.filter((record) => record.level === "warn" || record.level === "error");
    const problemsBefore = problems().length;

    await tick(harness);
    const states = [stateOf(harness, first), stateOf(harness, second)];
    expect(states.filter((state) => state === "absent")).toHaveLength(1);
    expect(states.filter((state) => state === "ready")).toHaveLength(1);
    expect(problems().length).toBeGreaterThan(problemsBefore);
    const failed = [first, second].find((device) => stateOf(harness, device) === "ready");
    expect(
      problems().filter((record) => record.message === "physical device action failed"),
    ).toMatchObject([
      { fields: { deviceId: failed?.id, error: expect.anything() }, level: "warn" },
    ]);

    await tick(harness);
    expect(stateOf(harness, first)).toBe("absent");
    expect(stateOf(harness, second)).toBe("absent");
  });

  it("a ready device read not present once and then present wakes the queue: a physical request waiting for it is granted on that tick", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const waiting = harness.engine.request(physicalRequest, asking("agent"));
    expect(await outcome(waiting)).toBe("pending");
    startWatcher(harness);

    await tick(harness);
    expect(readsOf(harness.driver)).toContainEqual(["UDID-A"]);
    back(harness, "UDID-A");
    expect(await outcome(waiting)).toBe("pending");

    await tick(harness);
    expect(await outcome(waiting)).toMatchObject({ device: { id: device.id } });
  });

  it("a tick whose read resolves present after dispose does not wake the queue: a physical request waiting for the device stays pending", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const waiting = harness.engine.request(physicalRequest, asking("agent"));
    expect(await outcome(waiting)).toBe("pending");
    startWatcher(harness);
    await tick(harness);
    back(harness, "UDID-A");
    harness.driver.holdPresenceReads("UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(3);

    watcherOf(harness)?.dispose();
    harness.driver.releasePresenceReads();

    expect(await outcome(waiting)).toBe("pending");
  });

  it("a tick whose read resolves after dispose writes nothing and starts no reclaim, and leasing.settle() resolves only after that tick", async () => {
    const ready = await createHarness();
    const readyDevice = await enrollIphone(ready, "UDID-A");
    gone(ready, "UDID-A");
    startWatcher(ready);
    await tick(ready);
    const readyWrites = recordStateWrites(ready);
    ready.driver.holdPresenceReads("UDID-A");
    ready.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(ready.driver)).toHaveLength(2);

    watcherOf(ready)?.dispose();
    const settling = ready.engine.leasing.settle();
    expect(await isSettled(settling)).toBe(false);
    ready.driver.releasePresenceReads();
    expect(await isSettled(settling)).toBe(true);
    expect(stateOf(ready, readyDevice)).toBe("ready");
    expect(readyWrites).toHaveLength(0);

    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    const writes = recordStateWrites(harness);
    harness.driver.holdPresenceReads("UDID-A");
    startWatcher(harness);
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(1);

    watcherOf(harness)?.dispose();
    harness.driver.releasePresenceReads();
    await flush();
    expect(stateOf(harness, device)).toBe("absent");
    expect(writes).toHaveLength(0);
    expect(reclaimCalls(harness.driver)).toHaveLength(0);
  });

  it("a platform with no driver changes no count and no state, and the other platform is still read", async () => {
    const harness = await createHarness();
    const iphone = await enrollIphone(harness, "UDID-A");
    const pixel = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "EMU-1",
      model: "Pixel 8",
      osVersion: "14",
      platform: "android",
    });
    gone(harness, "UDID-A");
    startWatcher(harness);

    await tick(harness, 10);

    expect(stateOf(harness, iphone)).toBe("absent");
    expect(stateOf(harness, pixel)).toBe("ready");
    expect(readsOf(harness.driver)[0]).toEqual(["UDID-A"]);
  });

  it("a listing entry whose ID has no record causes no write and no driver call but the listing", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    const listing = vi.spyOn(harness.driver, "listPresentPhysical").mockResolvedValue(
      answer([
        { driverDeviceId: "UDID-A", osVersion: "18.4", present: true },
        { driverDeviceId: "UDID-GHOST-1", osVersion: "18.4", present: true },
        { driverDeviceId: "UDID-GHOST-2", present: false, reason: "locked" },
      ]),
    );
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness, 3);

    expect(listing.mock.calls.length).toBeGreaterThan(0);
    expect(harness.driver.calls.map((call) => call.operation)).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("a ready device that stays not present for health.stableObservations reads emits one device.absence-detected with previousState ready and the last read's reason", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    gone(harness, "UDID-A", "locked");

    await tick(harness, 2);

    expect(eventsOf(harness, "device.absence-detected")).toMatchObject([
      { payload: { absentReason: "locked", deviceId: device.id, previousState: "ready" } },
    ]);
  });

  it("a ready device read present without a miss does not wake the queue", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    const kick = vi.spyOn(
      harness.engine.leasing.corePorts.leaseMaintenance.acquisition as unknown as { kick(): void },
      "kick",
    );
    startWatcher(harness);

    await tick(harness, 2);

    expect(readsOf(harness.driver)).toHaveLength(2);
    expect(kick).not.toHaveBeenCalled();
  });

  it("a ready device read not present once and then present wakes the queue once, not again on the next present read", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    const kick = vi.spyOn(
      harness.engine.leasing.corePorts.leaseMaintenance.acquisition as unknown as { kick(): void },
      "kick",
    );
    startWatcher(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    expect(kick).not.toHaveBeenCalled();

    back(harness, "UDID-A");
    await tick(harness);
    expect(kick).toHaveBeenCalledTimes(1);

    await tick(harness);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("a leased device read not present once and then present does not wake the queue", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    await harness.engine.request(physicalRequest, asking("agent"));
    expect(stateOf(harness, device)).toBe("leased");
    const kick = vi.spyOn(
      harness.engine.leasing.corePorts.leaseMaintenance.acquisition as unknown as { kick(): void },
      "kick",
    );
    gone(harness, "UDID-A");
    await tick(harness);
    back(harness, "UDID-A");

    await tick(harness);

    expect(stateOf(harness, device)).toBe("leased");
    expect(kick).not.toHaveBeenCalled();
  });

  it("an absent device read present returns with the osVersion of the read, or with the one on its record when the read has none", async () => {
    const withVersion = await absentHarness("not-present");
    vi.spyOn(withVersion.harness.driver, "listPresentPhysical").mockResolvedValue(
      answer([{ driverDeviceId: "UDID-A", osVersion: "18.5", present: true }]),
    );
    startWatcher(withVersion.harness);
    await tick(withVersion.harness);
    expect(eventsOf(withVersion.harness, "device.returned")).toMatchObject([
      { payload: { deviceId: withVersion.device.id, osVersion: "18.5" } },
    ]);

    const withoutVersion = await absentHarness("not-present");
    vi.spyOn(withoutVersion.harness.driver, "listPresentPhysical").mockResolvedValue(
      answer([{ driverDeviceId: "UDID-A", present: true }]),
    );
    startWatcher(withoutVersion.harness);
    await tick(withoutVersion.harness);
    expect(eventsOf(withoutVersion.harness, "device.returned")).toMatchObject([
      { payload: { deviceId: withoutVersion.device.id, osVersion: "18.4" } },
    ]);
  });

  it("a tick whose watcher is disposed while it acts on one device acts on no later device of that tick", async () => {
    const options = { health: { stableObservations: 1 } };
    const first = await createHarness(options);
    const missing = await enrollIphone(first, "UDID-A");
    const returned = await enrollIphone(first, "UDID-B");
    const harness = await reopen(
      first,
      (records) => markAbsent(records, "UDID-B", "not-present"),
      options,
    );
    gone(harness, "UDID-A");
    back(harness, "UDID-B");
    const original = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementationOnce(
      async (path, contents, writeOptions) => {
        watcherOf(harness)?.dispose();
        return original(path, contents, writeOptions);
      },
    );
    startWatcher(harness);

    await tick(harness);

    expect(stateOf(harness, missing)).toBe("absent");
    expect(stateOf(harness, returned)).toBe("absent");
    expect(reclaimCalls(harness.driver)).toEqual([]);
    expect(eventsOf(harness, "device.returned")).toEqual([]);
  });

  it("a tick whose watcher is disposed while it acts on one device does not wake the queue for a later device of that tick", async () => {
    const first = await createHarness();
    const missing = await enrollIphone(first, "UDID-A");
    const flickering = await enrollIphone(first, "UDID-B");
    gone(first, "UDID-A");
    gone(first, "UDID-B");
    const waiting = first.engine.request(physicalRequest, asking("agent"));
    expect(await outcome(waiting)).toBe("pending");
    startWatcher(first);
    await tick(first);
    back(first, "UDID-B");
    const original = first.filesystem.writeFileAtomic.bind(first.filesystem);
    vi.spyOn(first.filesystem, "writeFileAtomic").mockImplementationOnce(
      async (path, contents, writeOptions) => {
        watcherOf(first)?.dispose();
        return original(path, contents, writeOptions);
      },
    );

    await tick(first);

    expect(stateOf(first, missing)).toBe("absent");
    expect(stateOf(first, flickering)).toBe("ready");
    expect(await outcome(waiting)).toBe("pending");
  });
});

describe("PhysicalDeviceWatcher around restarts and doctor", () => {
  it("a device left reclaiming by a killed daemon, read present, whose re-run reclaim fails: still present, it is quarantined with device.quarantined only; read not present after the failure, it is absent with device.absence-detected previousState reclaiming", async () => {
    const restarted = async () => {
      const first = await createHarness();
      const device = await enrollIphone(first, "UDID-A");
      await first.registry.transitionDevice(device.id, "leased");
      await first.registry.transitionDevice(device.id, "reclaiming");
      const harness = await reopen(first, () => undefined);
      back(harness, "UDID-A");
      await harness.engine.convergeRunningCapacity();
      return { device, harness };
    };

    const present = await restarted();
    vi.spyOn(present.harness.driver, "reclaim").mockRejectedValueOnce(
      new Error("uninstall failed"),
    );
    startWatcher(present.harness);
    await tick(present.harness);
    expect(stateOf(present.harness, present.device)).toBe("quarantined");
    expect(eventsOf(present.harness, "device.quarantined")).toHaveLength(1);
    expect(eventsOf(present.harness, "device.purge-failed")).toEqual([]);
    expect(eventsOf(present.harness, "device.absence-detected")).toEqual([]);

    const unplugged = await restarted();
    vi.spyOn(unplugged.harness.driver, "reclaim").mockImplementationOnce(async () => {
      gone(unplugged.harness, "UDID-A");
      throw new Error("usb lost");
    });
    startWatcher(unplugged.harness);
    await tick(unplugged.harness);
    expect(stateOf(unplugged.harness, unplugged.device)).toBe("absent");
    expect(eventsOf(unplugged.harness, "device.absence-detected")).toMatchObject([
      {
        payload: {
          absentReason: "not-present",
          deviceId: unplugged.device.id,
          previousState: "reclaiming",
        },
      },
    ]);
    expect(eventsOf(unplugged.harness, "device.quarantined")).toEqual([]);
    expect(eventsOf(unplugged.harness, "device.purge-failed")).toEqual([]);
  });

  it("a physical device that entered reclaiming in this process and holds no claim is never reclaimed by the watcher", async () => {
    const first = await createHarness();
    const restartedDevice = await enrollIphone(first, "UDID-A");
    const processDevice = await enrollIphone(first, "UDID-B");
    await first.registry.transitionDevice(restartedDevice.id, "leased");
    await first.registry.transitionDevice(restartedDevice.id, "reclaiming");
    const harness = await reopen(first, () => undefined);
    back(harness, "UDID-A");
    back(harness, "UDID-B");
    await harness.engine.convergeRunningCapacity();
    await harness.registry.transitionDevice(processDevice.id, "leased");
    await harness.registry.transitionDevice(processDevice.id, "reclaiming");
    startWatcher(harness);

    await tick(harness, 3);

    expect(stateOf(harness, restartedDevice)).toBe("ready");
    expect(stateOf(harness, processDevice)).toBe("reclaiming");
    expect(
      reclaimCalls(harness.driver).filter((call) =>
        JSON.stringify(call.arguments).includes("UDID-B"),
      ),
    ).toEqual([]);
  });

  it("a device left reclaiming by a killed daemon that left reclaiming before the first tick, and entered it again in this process, is never reclaimed by the watcher", async () => {
    const first = await createHarness();
    const device = await enrollIphone(first, "UDID-A");
    await first.registry.transitionDevice(device.id, "leased");
    await first.registry.transitionDevice(device.id, "reclaiming");
    const harness = await reopen(first, () => undefined);
    back(harness, "UDID-A");
    await harness.engine.convergeRunningCapacity();
    await harness.registry.transitionDevice(device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 0, strategy: "uninstall" },
    });
    startWatcher(harness);
    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(reclaimCalls(harness.driver)).toEqual([]);

    await harness.registry.transitionDevice(device.id, "leased");
    await harness.registry.transitionDevice(device.id, "reclaiming");
    await tick(harness, 2);

    expect(readsOf(harness.driver)).toHaveLength(3);
    expect(stateOf(harness, device)).toBe("reclaiming");
    expect(reclaimCalls(harness.driver)).toEqual([]);
  });

  it("a device left reclaiming by a killed daemon that doctor --fix quarantines before the watcher's tick stays quarantined, and the watcher runs no reclaim on it", async () => {
    const options = { quarantineBackoffMs: 10 * DAY_MS };
    const first = await createHarness(options);
    const device = await enrollIphone(first, "UDID-A");
    await first.registry.transitionDevice(device.id, "leased");
    await first.registry.transitionDevice(device.id, "reclaiming");
    const harness = await reopen(
      first,
      (records) => {
        for (const record of records) record.lastLeaseEndedAt = 1;
      },
      options,
    );
    await harness.engine.convergeRunningCapacity();
    harness.clock.advance(DAY_MS);
    await harness.engine.core.doctor.reconcile({ fix: true });
    expect(stateOf(harness, device)).toBe("quarantined");
    back(harness, "UDID-A");
    startWatcher(harness);

    await tick(harness, 3);

    expect(readsOf(harness.driver)).toContainEqual(["UDID-A"]);
    expect(stateOf(harness, device)).toBe("quarantined");
    expect(reclaimCalls(harness.driver)).toEqual([]);
  });
});

describe("PhysicalDeviceWatcher and nuke maintenance", () => {
  it("the device-lost ending waits while nuke maintenance is active, and runs when it ends", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    await harness.engine.request(physicalRequest, asking("agent"));
    gone(harness, "UDID-A");
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();

    await tick(harness, 3);
    expect(readsOf(harness.driver).length).toBeGreaterThan(0);
    expect(stateOf(harness, device)).toBe("leased");
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    await maintenance.endMaintenance();
    await flush();
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(eventsOf(harness, "lease.released")).toMatchObject([
      { payload: { reason: "device-lost" } },
    ]);
  });

  it("while nuke maintenance is active, a ready device past the grace period stays ready, an absent device read with another reason keeps its old one, and an absent device read present gets no write and no reclaim; all three are acted on once maintenance ends", async () => {
    const options = { health: { stableObservations: 3 } };
    const first = await createHarness(options);
    const ready = await enrollIphone(first, "UDID-R");
    const reasoned = await enrollIphone(first, "UDID-X");
    const returned = await enrollIphone(first, "UDID-Y");
    const harness = await reopen(
      first,
      (records) => {
        markAbsent(records, "UDID-X", "locked");
        markAbsent(records, "UDID-Y", "locked");
      },
      options,
    );
    gone(harness, "UDID-R");
    gone(harness, "UDID-X", "locked");
    gone(harness, "UDID-Y", "locked");
    startWatcher(harness);
    await tick(harness, 2);
    const writes = recordStateWrites(harness);
    gone(harness, "UDID-X", "not-present");
    back(harness, "UDID-Y");
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();

    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(3);
    expect(stateOf(harness, ready)).toBe("ready");
    expect(absentReasonOf(harness, reasoned)).toBe("locked");
    expect(stateOf(harness, returned)).toBe("absent");
    expect(writes).toHaveLength(0);
    expect(reclaimCalls(harness.driver)).toHaveLength(0);

    await maintenance.endMaintenance();
    await flush();
    await tick(harness);
    expect(stateOf(harness, ready)).toBe("absent");
    expect(absentReasonOf(harness, reasoned)).toBe("not-present");
    expect(reclaimCalls(harness.driver)).toHaveLength(1);
    expect(["reclaiming", "ready"]).toContain(stateOf(harness, returned));
  });

  it.each([
    {
      name: "nuke's lease maintenance, begun while it runs,",
      start: (harness: Harness) =>
        harness.engine.leasing.corePorts.leaseMaintenance.leases.beginMaintenance(),
      finish: async (harness: Harness) => {
        await harness.engine.leasing.corePorts.leaseMaintenance.leases.endMaintenance();
      },
    },
    {
      name: "leasing.settle()",
      start: (harness: Harness) => harness.engine.leasing.settle(),
      finish: async (harness: Harness, device: PhysicalDevice) => {
        expect(stateOf(harness, device)).toBe("ready");
      },
    },
  ])("$name resolves only after a return reclaim the watcher started has settled", async (row) => {
    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    const gate = holdNextReclaim(harness);
    startWatcher(harness);
    await tick(harness);
    expect(reclaimCalls(harness.driver)).toHaveLength(1);

    const waiting = row.start(harness);
    expect(await isSettled(waiting)).toBe(false);

    gate.resolve();
    expect(await isSettled(waiting)).toBe(true);
    await row.finish(harness, device);
  });

  it("an absentReason rewrite held back by nuke maintenance is dropped when the watcher is disposed before maintenance ends", async () => {
    const { device, harness } = await absentHarness("locked");
    gone(harness, "UDID-A", "not-present");
    startWatcher(harness);
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();
    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(1);

    watcherOf(harness)?.dispose();
    await maintenance.endMaintenance();
    await flush();

    expect(absentReasonOf(harness, device)).toBe("locked");
  });

  it("a return reclaim waiting on nuke maintenance when the watcher is disposed never starts: the device stays absent", async () => {
    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    startWatcher(harness);
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();
    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(1);

    watcherOf(harness)?.dispose();
    await maintenance.endMaintenance();
    await flush();

    expect(stateOf(harness, device)).toBe("absent");
    expect(reclaimCalls(harness.driver)).toHaveLength(0);
  });

  it("a device-lost ending waiting on nuke maintenance when the watcher is disposed leaves the lease in place", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    await harness.engine.request(physicalRequest, asking("agent"));
    gone(harness, "UDID-A");
    await tick(harness);
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();
    await tick(harness);
    expect(readsOf(harness.driver).length).toBeGreaterThan(1);

    watcherOf(harness)?.dispose();
    await maintenance.endMaintenance();
    await flush();

    expect(stateOf(harness, device)).toBe("leased");
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });
});
