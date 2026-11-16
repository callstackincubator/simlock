import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  type Filesystem,
  type Logger,
  MemoryFilesystem,
  type TimerHandle,
} from "../ports/index.js";
import { ComponentInstaller, type ComponentInstallRequest } from "./component-installer.js";
import { DiskSpaceGuard } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import { SerializedDecision } from "./serialized-decision.js";

export const gibibyte = 1024 ** 3;
export const timeoutMs = 60_000;

/** A clock whose timers fire only when a test fires them, one at a time, by creation order. */
export class ManualClock extends FakeClock {
  readonly #timers: { callback: () => void; cancelled: boolean }[] = [];

  override setTimer(_delayMs: number, callback: () => void): TimerHandle {
    const timer = { callback, cancelled: false };
    this.#timers.push(timer);
    return timer as unknown as TimerHandle;
  }

  override cancel(handle: TimerHandle): void {
    (handle as unknown as { cancelled: boolean }).cancelled = true;
  }

  fire(index: number): void {
    const timer = this.#timers[index];
    if (timer === undefined || timer.cancelled) throw new Error(`No live timer ${String(index)}`);
    timer.cancelled = true;
    timer.callback();
  }
}

export async function createHarness(
  options: {
    readonly clock?: FakeClock;
    readonly drivers?: (clock: FakeClock) => readonly FakeDriver[];
    readonly decisions?: Pick<SerializedDecision, "run">;
    readonly filesystem?: (clock: FakeClock) => Pick<Filesystem, "diskFree">;
    readonly freeDiskBytes?: number;
    readonly logger?: Logger;
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const bus = new EventBus(clock);
  const events: { readonly event: string; readonly payload: unknown }[] = [];
  bus.subscribeAll((envelope) => {
    if (envelope.event.startsWith("component.")) {
      events.push({ event: envelope.event, payload: envelope.payload });
    }
  });
  const drivers = options.drivers?.(clock) ?? [
    new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
  ];
  const state = await openTestState();
  let nextId = 0;
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => `id${String((nextId += 1))}` },
    state,
  });
  // Every reservation the installer takes, and whether it gave it back.
  const guard = new DiskSpaceGuard();
  const reservations: { readonly bytes: number; released: boolean }[] = [];
  const installer = new ComponentInstaller({
    clock,
    decisions: options.decisions ?? new SerializedDecision(),
    diskSpace: {
      reserve: async (filesystem, platform, bytes, path) => {
        const release = await guard.reserve(filesystem, platform, bytes, path);
        const reservation = { bytes, released: false };
        reservations.push(reservation);
        return () => {
          reservation.released = true;
          release();
        };
      },
    },
    drivers: new DriverCatalog(drivers),
    eventBus: bus,
    filesystem: options.filesystem?.(clock) ?? new MemoryFilesystem(options.freeDiskBytes),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
    timeoutMs,
  });
  const ios = drivers.find((driver) => driver.platform === "ios") as FakeDriver;
  return {
    bus,
    clock,
    drivers,
    events,
    installer,
    ios,
    registry,
    reservations,
    state,
  };
}

export function installs(driver: FakeDriver): readonly unknown[] {
  return driver.calls
    .filter((call) => call.operation === "installComponent")
    .map((call) => call.arguments[0]);
}

/** Lets every settled promise and queued continuation run. */
export async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    await Promise.resolve();
  }
}

/** A promise's outcome without awaiting it, so a test can look while it is still open. */
export function track<T>(promise: Promise<T>): {
  readonly settled: () => boolean;
  readonly result: () => T | undefined;
  readonly error: () => unknown;
} {
  let state: { kind: "open" } | { kind: "ok"; value: T } | { kind: "error"; error: unknown } = {
    kind: "open",
  };
  promise.then(
    (value) => {
      state = { kind: "ok", value };
    },
    (error: unknown) => {
      state = { error, kind: "error" };
    },
  );
  return {
    error: () => (state.kind === "error" ? state.error : undefined),
    result: () => (state.kind === "ok" ? state.value : undefined),
    settled: () => state.kind !== "open",
  };
}

export function ios(component: string, extra: Partial<ComponentInstallRequest> = {}) {
  return { component, platform: "ios" as const, ...extra };
}
