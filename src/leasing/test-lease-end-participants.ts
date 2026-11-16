import { expect } from "vitest";
import { EventBus } from "../bus/index.js";
import { type Config, type DriverDevice, type LeaseGrant, type Registry } from "../core/index.js";
import {
  FakeDriver,
  type FakeDriverOptions,
  loadTestRegistry,
  openTestState,
  testComponentWiring,
  testStateOf,
} from "../core/testing.js";
import { type StateDatabase } from "../state/index.js";
import { FakeClock, FakeSystemStats, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { type EndedLease, type LeaseEndParticipant } from "./lease-ports.js";
import { createTestEngine, type TestEngine, type TestEngineConfig } from "./testing.js";

const gibibyte = 1024 ** 3;

export const END_WAIT_MS = 600_000;

export const PROBE_MS = 30_000;

export const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

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

export class TestParticipant implements LeaseEndParticipant {
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

export interface World {
  readonly bus: EventBus;
  readonly clock: FakeClock;
  readonly driver: FakeDriver;
  readonly state: StateDatabase;
  readonly ids: { next: number };
  readonly sink: MemoryLogSink;
}

export async function createWorld(driverOptions: Partial<FakeDriverOptions> = {}): Promise<World> {
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
    ids: { next: 1 },
    sink: new MemoryLogSink(),
    state: await openTestState(),
  };
}

interface EngineOptions {
  readonly ios?: { readonly maxDevices: number; readonly maxRunning: number };
  readonly lease?: Partial<Config["lease"]>;
  readonly participants?: readonly LeaseEndParticipant[];
  readonly world?: World;
}

function config(options: EngineOptions): TestEngineConfig {
  const ios = options.ios ?? { maxDevices: 1, maxRunning: 1 };
  return {
    devices: { autoEnroll: false, deletedRetentionMs: 3_600_000 },
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
      endedIdRetentionMs: 600_000,
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

export interface Harness extends World {
  readonly engine: TestEngine;
  readonly registry: Registry;
  readonly world: World;
}

export const started: TestEngine[] = [];

export async function startEngine(options: EngineOptions = {}): Promise<Harness> {
  const world = options.world ?? (await createWorld());
  const { bus, clock, driver, ids, sink, state } = world;
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => `${ids.next++}` },
    state,
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
    state: testStateOf(registry),
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

export function asking(requesterId: string) {
  return { ownerId: `${requesterId}-owner`, requesterId };
}

export async function flush(): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    await Promise.resolve();
  }
}

export async function settledOrPending(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.catch((error: unknown) => error),
    flush().then(() => "still pending"),
  ]);
}

export /** why: a released virtual device is destroyed, never reclaimed, so the destroy marks the end of the wait. */
function destroys(driver: FakeDriver) {
  return driver.calls.filter((call) => call.operation === "destroy");
}

export function stateOf(harness: Harness, deviceId: string): string | undefined {
  return harness.registry.snapshot.devices.find((device) => device.id === deviceId)?.state;
}

export function markerOf(harness: Harness, deviceId: string): string | undefined {
  const device = harness.registry.snapshot.devices.find((candidate) => candidate.id === deviceId);
  return (device as { deferredReclaimLeaseId?: string } | undefined)?.deferredReclaimLeaseId;
}

export function warningsFor(world: World, leaseId: string) {
  return world.sink.records.filter(
    (record) => record.level === "warn" && record.fields?.leaseId === leaseId,
  );
}

export function errorsFor(world: World, leaseId: string) {
  return world.sink.records.filter(
    (record) => record.level === "error" && record.fields?.leaseId === leaseId,
  );
}

export async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
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

export async function leaseAndRelease(options: EngineOptions = {}) {
  const participant = new TestParticipant();
  const harness = await startEngine({ participants: [participant], ...options });
  const grant = await harness.engine.request(request, asking("agent"));
  await harness.engine.release(grant.lease.id, "explicit");
  await flush();
  return { grant, harness, participant };
}

export async function endStartupLease(options: {
  readonly afterFirstStop?: (first: Harness, grant: LeaseGrant) => void | Promise<void>;
  readonly participant: TestParticipant;
  readonly ttlMs?: number;
}) {
  const world = await createWorld();
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

export function driverDeviceOf(harness: Harness, deviceId: string): DriverDevice {
  const device = harness.registry.snapshot.devices.find((candidate) => candidate.id === deviceId);
  if (device === undefined) throw new Error(`no device ${deviceId}`);
  return { address: "", deviceId: device.driverDeviceId, driverData: device.driverData };
}
