import { vi } from "vitest";
import { type Config, type DeviceRequest, type PhysicalDevice, Registry } from "../core/index.js";
import {
  FakeDriver,
  loadTestRegistry,
  openTestState,
  testComponentWiring,
  testStateOf,
} from "../core/testing.js";
import { type StateDatabase } from "../state/index.js";
import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, type Logger, type SqliteDatabase } from "../ports/index.js";
import { createTestEngine, type TestEngine, type TestEngineConfig } from "./testing.js";

const gibibyte = 1024 ** 3;

export const PROBE_MS = 30_000;

export const physicalRequest = {
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

function config(options: HarnessOptions): TestEngineConfig {
  const quarantineBackoffMs = options.quarantineBackoffMs ?? 30_000;
  return {
    android: { virtualDevices: true },
    devices: { autoEnroll: false, deletedRetentionMs: 3_600_000 },
    ios: { modes: ["slim", "full"], virtualDevices: true },
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
      endedIdRetentionMs: 600_000,
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

export interface Harness {
  readonly androidDriver: FakeDriver;
  readonly bus: EventBus;
  readonly clock: FakeClock;
  readonly driver: FakeDriver;
  readonly engine: TestEngine;
  readonly registry: Registry;
  readonly state: StateDatabase;
}

export const harnesses: Harness[] = [];

export async function createHarness(
  options: HarnessOptions = {},
  state?: StateDatabase,
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
  const stateDatabase = state ?? (await openTestState());
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => `${nextId++}` },
    state: stateDatabase,
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
    state: testStateOf(registry),
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
  });
  const harness = {
    androidDriver,
    bus,
    clock,
    driver,
    engine,
    registry,
    state: stateDatabase,
  };
  harnesses.push(harness);
  return harness;
}

interface WatcherHandle {
  start(): void;
  dispose(): void;
}

export function watcherOf(harness: Harness): WatcherHandle | undefined {
  return (harness.engine.leasing as unknown as { physicalDeviceWatcher?: WatcherHandle })
    .physicalDeviceWatcher;
}

export function startWatcher(harness: Harness): void {
  watcherOf(harness)?.start();
}

export async function reopen(
  first: Harness,
  patch: (database: SqliteDatabase) => void,
  options: HarnessOptions = {},
): Promise<Harness> {
  patch(first.state.database);
  first.engine.dispose();
  return createHarness(options, first.state);
}

export function markAbsent(
  database: SqliteDatabase,
  driverDeviceId: string,
  absentReason: string,
): void {
  const { changes } = database
    .prepare("UPDATE devices SET state = 'absent', absent_reason = ? WHERE driver_device_id = ?")
    .run(absentReason, driverDeviceId);
  if (changes === 0) throw new Error(`no record for ${driverDeviceId}`);
}

export async function enrollIphone(
  harness: Harness,
  driverDeviceId: string,
): Promise<PhysicalDevice> {
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

export async function absentHarness(
  reason: string,
  options: HarnessOptions = {},
): Promise<{ readonly device: PhysicalDevice; readonly harness: Harness }> {
  const first = await createHarness(options);
  const device = await enrollIphone(first, "UDID-A");
  const harness = await reopen(
    first,
    (database) => markAbsent(database, "UDID-A", reason),
    options,
  );
  return { device, harness };
}

export function asking(requesterId: string) {
  return { ownerId: requesterId, requesterId };
}

export async function flush(): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    await Promise.resolve();
  }
}

export async function tick(harness: Harness, times = 1): Promise<void> {
  for (let count = 0; count < times; count += 1) {
    harness.clock.advance(PROBE_MS);
    await flush();
  }
}

export async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), flush().then(() => false)]);
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function gone(
  harness: Harness,
  driverDeviceId: string,
  reason?: "locked" | "untrusted" | "not-present",
): void {
  harness.driver.setPhysicalPresence(driverDeviceId, false, reason === undefined ? {} : { reason });
}

export function back(harness: Harness, driverDeviceId: string): void {
  harness.driver.setPhysicalPresence(driverDeviceId, true);
}

export function stateOf(harness: Harness, device: PhysicalDevice): string | undefined {
  return harness.registry.snapshot.devices.find((candidate) => candidate.id === device.id)?.state;
}

export function absentReasonOf(harness: Harness, device: PhysicalDevice): unknown {
  const record = harness.registry.snapshot.devices.find((candidate) => candidate.id === device.id);
  return (record as unknown as Record<string, unknown> | undefined)?.absentReason;
}

export function eventsOf(harness: Harness, name: string) {
  return harness.bus.replay().filter((event) => String(event.event) === name);
}

export function readEntriesOf(driver: FakeDriver): unknown[] {
  return driver.calls
    .filter((call) => call.operation === "listPresentPhysical")
    .map((call) => call.arguments[0]);
}

export function readsOf(driver: FakeDriver): unknown[] {
  return readEntriesOf(driver).map((entries) =>
    (entries as readonly { readonly driverDeviceId: string }[]).map(
      (entry) => entry.driverDeviceId,
    ),
  );
}

const heldReclaims = new WeakMap<FakeDriver, number>();

export function reclaimCalls(driver: FakeDriver) {
  const held = Array.from({ length: heldReclaims.get(driver) ?? 0 }, () => ({
    arguments: [] as unknown[],
    operation: "reclaim" as const,
  }));
  return [...driver.calls.filter((call) => call.operation === "reclaim"), ...held];
}

type PresenceAnswer = Awaited<ReturnType<FakeDriver["listPresentPhysical"]>>;

export function answer(
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

export function recordStateWrites(harness: Harness): RecordedWrite[] {
  const writes: RecordedWrite[] = [];
  const original = harness.state.transaction.bind(harness.state);
  vi.spyOn(harness.state, "transaction").mockImplementation((work) =>
    original(() => {
      const result = work();
      const records = harness.state.database.prepare("SELECT id, state FROM devices").all() as {
        id: string;
        state: string;
      }[];
      writes.push({
        claims: Object.fromEntries(
          records.map((record) => [record.id, harness.engine.core.claims.claim(record.id)?.kind]),
        ),
        states: Object.fromEntries(records.map((record) => [record.id, record.state])),
      });
      return result;
    }),
  );
  return writes;
}

export function holdNextReclaim(harness: Harness): { readonly resolve: () => void } {
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
