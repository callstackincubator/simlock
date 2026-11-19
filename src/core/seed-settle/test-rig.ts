import { expect } from "vitest";

import { FakeSystemStats, JsonLinesLogger, MemoryLogSink } from "../../ports/index.js";
import { CapacityCoordinator, createCapacityStrategy } from "../capacity/index.js";
import type { MemoryPressureReader } from "../core-ports.js";
import type { DriverSettleResult, DriverSource } from "../driver.js";
import { FakeDriver } from "../fake-driver.js";
import { SerializedDecision } from "../serialized-decision.js";
import { flush, createHarness } from "../test-component-installer.js";
import { testConfig } from "../testing.js";
import { createSeedSettler } from "./index.js";
import type { SeedSettler, SettlerDriver } from "./types.js";

export { flush };

type PressureReading = ReturnType<MemoryPressureReader["current"]>;

/** why: a memory pressure port the test drives: `reading` sets the state and calls every listener, as the sampler does after each reading. */
function fakeMemoryPressure(initial: PressureReading) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    reader: {
      current: () => current,
      onReading: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } satisfies MemoryPressureReader,
    reading(next: PressureReading): void {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}
export const minute = 60_000;
export const THRESHOLD = 10 * 1024 ** 3;

export const quick = (
  id: string,
  leases: number,
  extra: Partial<DriverSource> = {},
): DriverSource => ({
  id,
  kind: "seed",
  leases,
  model: "iPhone 17",
  osVersion: "26.5",
  settled: false,
  ...extra,
});

export const none = { readingAt: 0, step: "none" } as const;
export const warmingPaused = { readingAt: 0, step: "warming-paused" } as const;
export const newDevicesPaused = { readingAt: 0, step: "new-devices-paused" } as const;

interface DriverRig {
  sources: DriverSource[];
  /** why: each call to `settleSeed` with the signal the settler gave it. */
  readonly settles: { readonly sourceId: string; readonly signal: AbortSignal }[];
  settleSeed?: (sourceId: string, signal: AbortSignal) => Promise<DriverSettleResult>;
  listSources?: () => Promise<readonly DriverSource[]>;
  listCalls: number;
}

export interface RigOptions {
  readonly pressure?: MemoryPressureReader["current"] extends () => infer Reading ? Reading : never;
  readonly freeBytes?: number;
  /** why: a platform with a driver that offers no settle verb. */
  readonly androidWithoutVerb?: boolean;
}

/** why: the settler with a real capacity coordinator, installer and decision gate, and a fake driver per platform. */
export async function settlerRig(options: RigOptions = {}) {
  const harness = await createHarness({
    drivers: (clock) => [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
  });
  const pressure = fakeMemoryPressure(options.pressure ?? none);
  const capacity = new CapacityCoordinator(
    createCapacityStrategy(
      testConfig().capacity,
      new FakeSystemStats({ cpuCount: 8, totalRamBytes: 64 * 1024 ** 3 }),
    ),
    () => undefined,
    pressure.reader,
  );
  const disk = { freeBytes: options.freeBytes ?? THRESHOLD };
  const sink = new MemoryLogSink();
  const ios: DriverRig = { listCalls: 0, settles: [], sources: [] };
  const android: DriverRig = { listCalls: 0, settles: [], sources: [] };
  const drive = (platform: "ios" | "android", rig: DriverRig, verb: boolean): SettlerDriver => ({
    platform,
    listSources: async () => {
      rig.listCalls += 1;
      return rig.listSources === undefined ? [...rig.sources] : rig.listSources();
    },
    ...(verb
      ? {
          settleSeed: async (sourceId, { signal }) => {
            rig.settles.push({ signal, sourceId });
            if (rig.settleSeed !== undefined) return rig.settleSeed(sourceId, signal);
            return { reason: "idle", settledAfterMs: 181_000, sourceId: `${sourceId}-settled` };
          },
        }
      : {}),
  });
  const settler: SeedSettler = createSeedSettler({
    capacity,
    clock: harness.clock,
    components: harness.installer,
    decisions: new SerializedDecision(),
    diskPressure: { freeBytesThreshold: THRESHOLD },
    drivers: [
      drive("ios", ios, true),
      drive("android", android, options.androidWithoutVerb !== true),
    ],
    eventBus: harness.bus,
    filesystem: { diskFree: async () => disk.freeBytes },
    logger: new JsonLinesLogger({ clock: harness.clock, sink }),
    memoryPressure: pressure.reader,
    registry: harness.registry,
  });
  /** why: the time a test lets pass; the settler's work is microtasks only, so flushing ends it. */
  const advance = async (ms: number): Promise<void> => {
    harness.clock.advance(ms);
    await flush();
  };
  return {
    advance,
    android,
    capacity,
    clock: harness.clock,
    disk,
    harness,
    ios,
    logs: () => sink.records,
    pressure,
    settler,
    /** why: starts the settler and lets its first check run. */
    async started() {
      settler.start();
      await flush();
    },
  };
}

export type SettlerRig = Awaited<ReturnType<typeof settlerRig>>;

export function expectSettled(rig: SettlerRig, expected: readonly string[], name: string): void {
  expect(
    [...rig.ios.settles, ...rig.android.settles].map((call) => call.sourceId),
    name,
  ).toEqual(expected);
}

/** why: a creation reservation the way a lease takes it, so the settler sees a boot under way. */
export function leaseReservation(rig: SettlerRig) {
  const attempt = rig.capacity.tryReserveProvisioning({ mode: "full", platform: "ios" }, []);
  if (!attempt.ok) throw new Error("the test's reservation was refused");
  return attempt.reservation;
}

/** why: a driver call the test holds open and then ends, as a settle that takes minutes does. */
export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

export const settledResult = (sourceId: string): DriverSettleResult => ({
  reason: "idle",
  settledAfterMs: 181_000,
  sizeBytes: 1_800_000_000,
  sourceId: `${sourceId}-settled`,
});
