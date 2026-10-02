import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  type Filesystem,
  type Logger,
  MemoryFilesystem,
  type TimerHandle,
} from "../ports/index.js";
import {
  ComponentInstaller,
  ComponentInstallerClosedError,
  type ComponentInstallerProgress,
  type ComponentInstallRequest,
} from "./component-installer.js";
import {
  ComponentInstallTimeoutError,
  DiskSpaceGuard,
  type DriverComponent,
  DriverCrashError,
  InsufficientDiskSpaceError,
} from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const timeoutMs = 60_000;

/** A clock whose timers fire only when a test fires them, one at a time, by creation order. */
class ManualClock extends FakeClock {
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

async function createHarness(
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
  const stateFilesystem = new MemoryFilesystem();
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem: stateFilesystem,
    idGenerator: { generate: () => `id${String((nextId += 1))}` },
    statePath,
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
    stateFilesystem,
  };
}

function installs(driver: FakeDriver): readonly unknown[] {
  return driver.calls
    .filter((call) => call.operation === "installComponent")
    .map((call) => call.arguments[0]);
}

/** Lets every settled promise and queued continuation run. */
async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    await Promise.resolve();
  }
}

/** A promise's outcome without awaiting it, so a test can look while it is still open. */
function track<T>(promise: Promise<T>): {
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

function ios(component: string, extra: Partial<ComponentInstallRequest> = {}) {
  return { component, platform: "ios" as const, ...extra };
}

describe("ComponentInstaller", () => {
  it("admits a call synchronously, before any progress, and a throwing onAdmitted does not stop its install", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();
    const heard: string[] = [];
    void harness.installer.install(ios("27.0")).catch(() => undefined);

    const call = track(
      harness.installer.install(
        ios("28.0", {
          onAdmitted: () => {
            heard.push("admitted");
            throw new Error("observer failure");
          },
          onProgress: (progress) => heard.push(progress.stage),
        }),
      ),
    );
    expect(heard).toEqual(["admitted", "waiting"]);

    harness.ios.releaseInstalls();
    await flush();
    expect(call.result()).toEqual({ outcome: "installed", version: "28.0" });
  });

  it("refuses a platform with no driver without admitting the call", async () => {
    const harness = await createHarness();
    const onAdmitted = vi.fn();

    await expect(
      harness.installer.install({ component: "35", onAdmitted, platform: "android" }),
    ).rejects.toMatchObject({ name: "NoDriverError" });
    expect(onAdmitted).not.toHaveBeenCalled();
  });

  it("runs one install for calls that name the same component, and every call gets its outcome", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const calls = [1, 2, 3].map(() => track(harness.installer.install(ios("27.0"))));
    await flush();
    harness.ios.releaseInstalls();
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
    for (const call of calls) {
      expect(call.result()).toEqual({ outcome: "installed", version: "27.0" });
    }
  });

  it("emits component.install-started and component.installed once each for an install three calls joined", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    for (const requesterId of ["a", "b", "c"]) {
      void harness.installer.install(ios("27.0", { requesterId }));
    }
    await flush();
    harness.clock.advance(5_000);
    harness.ios.releaseInstalls();
    await flush();

    expect(harness.events).toEqual([
      {
        event: "component.install-started",
        payload: { componentId: "27.0", platform: "ios", requesterId: "a" },
      },
      {
        event: "component.installed",
        payload: {
          alreadyPresent: false,
          componentId: "27.0",
          durationMs: 5_000,
          platform: "ios",
          requesterId: "a",
          version: "27.0",
        },
      },
    ]);
  });

  it("starts a second component's install on the same platform only after the first one has ended", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const first = track(harness.installer.install(ios("27.0")));
    const second = track(harness.installer.install(ios("28.0")));
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
    harness.ios.releaseInstalls();
    harness.ios.holdInstalls();
    await flush();

    expect(first.settled()).toBe(true);
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);
    expect(second.settled()).toBe(false);
    harness.ios.releaseInstalls();
    await flush();
    expect(second.result()).toEqual({ outcome: "installed", version: "28.0" });
  });

  it("tells a call that is behind another install that it is waiting, and fans the driver's progress out to every joined call", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, installProgress: [40], platform: "ios" }),
      ],
    });
    harness.ios.holdInstalls();
    const firstA: ComponentInstallerProgress[] = [];
    const firstB: ComponentInstallerProgress[] = [];
    const behind: ComponentInstallerProgress[] = [];

    void harness.installer.install(ios("27.0", { onProgress: (report) => firstA.push(report) }));
    void harness.installer.install(ios("27.0", { onProgress: (report) => firstB.push(report) }));
    void harness.installer.install(ios("28.0", { onProgress: (report) => behind.push(report) }));
    await flush();

    // The first report is the install's start, before the driver's own percentage.
    expect(firstA).toEqual([{ stage: "downloading" }, { percent: 40, stage: "downloading" }]);
    expect(firstB).toEqual([{ stage: "downloading" }, { percent: 40, stage: "downloading" }]);
    expect(behind).toEqual([{ stage: "waiting" }]);
  });

  it("tells a call that its install started, with no percent, before the driver reports anything, and a call behind it hears the same when its own turn comes", async () => {
    const harness = await createHarness({
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    harness.ios.holdInstalls();
    const first: ComponentInstallerProgress[] = [];
    const behind: ComponentInstallerProgress[] = [];

    void harness.installer.install(ios("27.0", { onProgress: (report) => first.push(report) }));
    void harness.installer.install(ios("28.0", { onProgress: (report) => behind.push(report) }));
    await flush();

    // The driver is holding and has reported nothing: the start report is the installer's own.
    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(first).toEqual([{ stage: "downloading" }]);
    expect(behind).toEqual([{ stage: "waiting" }]);

    harness.ios.releaseInstalls();
    harness.ios.holdInstalls();
    await flush();
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);
    expect(behind).toEqual([{ stage: "waiting" }, { stage: "downloading" }]);
  });

  it("tells a call that joins a running install its latest report at once, and only that one", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          installProgress: [12, 41],
          platform: "ios",
        }),
      ],
    });
    harness.ios.holdInstalls();
    const early: ComponentInstallerProgress[] = [];
    const joiner: ComponentInstallerProgress[] = [];

    void harness.installer.install(ios("27.0", { onProgress: (report) => early.push(report) }));
    await flush();
    expect(early).toEqual([
      { stage: "downloading" },
      { percent: 12, stage: "downloading" },
      { percent: 41, stage: "downloading" },
    ]);

    void harness.installer.install(ios("27.0", { onProgress: (report) => joiner.push(report) }));
    // Synchronously, before anything else runs: the latest report, and only that one.
    expect(joiner).toEqual([{ percent: 41, stage: "downloading" }]);
    expect(early).toHaveLength(3);
  });

  it("still lists a running install as downloading and one behind it as waiting after a call joined the running one", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, installProgress: [41], platform: "ios" }),
      ],
    });
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    void harness.installer.install(ios("28.0"));
    await flush();
    void harness.installer.install(ios("27.0", { onProgress: () => undefined }));

    expect(harness.installer.inProgress()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 2 },
      { component: "28.0", platform: "ios", since: 1_000, state: "waiting", waiters: 1 },
    ]);
  });

  it("runs an iOS install and an Android install at the same time", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: [], clock, platform: "android" }),
      ],
    });
    for (const driver of harness.drivers) driver.holdInstalls();

    void harness.installer.install(ios("27.0"));
    void harness.installer.install({ component: "35", platform: "android" });
    await flush();

    expect(harness.drivers.map((driver) => installs(driver))).toEqual([["27.0"], ["35"]]);
  });

  it("rejects every call joined to a failed install with that failure, and the next call starts a new install", async () => {
    const harness = await createHarness();
    const failure = new DriverCrashError("xcodebuild failed");
    harness.ios.failOn("installComponent", 1, failure);

    const joined = await Promise.allSettled([
      harness.installer.install(ios("27.0")),
      harness.installer.install(ios("27.0")),
    ]);
    const next = await harness.installer.install(ios("27.0"));

    expect(joined).toEqual([
      { reason: failure, status: "rejected" },
      { reason: failure, status: "rejected" },
    ]);
    expect(next).toEqual({ outcome: "installed", version: "27.0" });
    expect(installs(harness.ios)).toEqual(["27.0", "27.0"]);
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.install-failed",
      "component.install-started",
      "component.installed",
    ]);
  });

  it("ends a call whose stillNeeded answers false as not-needed, with no install and no event", async () => {
    const harness = await createHarness();

    await expect(
      harness.installer.install(ios("27.0", { stillNeeded: async () => false })),
    ).resolves.toEqual({ outcome: "not-needed" });
    expect(harness.ios.calls.map((call) => call.operation)).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("runs a waiting call's stillNeeded when it reaches the front, after the install ahead of it ended", async () => {
    const harness = await createHarness({
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    harness.ios.holdInstalls();
    let asked = 0;

    void harness.installer.install(ios("27.0"));
    const waiting = track(
      harness.installer.install(
        ios("latest", {
          stillNeeded: async () => {
            asked += 1;
            return (await harness.ios.findComponent("27.0")) === undefined;
          },
        }),
      ),
    );
    await flush();
    expect(asked).toBe(0);
    harness.ios.releaseInstalls();
    await flush();

    expect(asked).toBe(1);
    expect(waiting.result()).toEqual({ outcome: "not-needed" });
    expect(installs(harness.ios)).toEqual(["27.0"]);
  });

  it("answers already-installed for an installed component with no reservation, no event and no install, even on a full disk", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: ["26.5"],
          clock,
          componentFootprint: { bytes: 8 * gibibyte, path: "/volume" },
          platform: "ios",
        }),
      ],
      freeDiskBytes: gibibyte,
    });

    await expect(harness.installer.install(ios("26.5"))).resolves.toEqual({
      outcome: "already-installed",
      version: "26.5",
    });
    expect(installs(harness.ios)).toEqual([]);
    expect(harness.reservations).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.registry.snapshot.components).toEqual([]);
  });

  it("fails with InsufficientDiskSpaceError and never calls installComponent when the footprint does not fit", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          componentFootprint: { bytes: 8 * gibibyte, path: "/volume" },
          platform: "ios",
        }),
      ],
      freeDiskBytes: 4 * gibibyte,
    });

    await expect(harness.installer.install(ios("27.0"))).rejects.toBeInstanceOf(
      InsufficientDiskSpaceError,
    );
    expect(installs(harness.ios)).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("refuses the second of two installs on different platforms that fit one at a time but not together, before its driver is called", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          componentFootprint: { bytes: 6 * gibibyte, path: "/volume" },
          platform: "ios",
        }),
        new FakeDriver({
          availableOsVersions: [],
          clock,
          componentFootprint: { bytes: 6 * gibibyte, path: "/volume" },
          platform: "android",
        }),
      ],
      freeDiskBytes: 10 * gibibyte,
    });
    const [iosDriver, androidDriver] = harness.drivers as [FakeDriver, FakeDriver];
    iosDriver.holdInstalls();

    const first = track(harness.installer.install(ios("27.0")));
    await flush();
    await expect(
      harness.installer.install({ component: "35", platform: "android" }),
    ).rejects.toBeInstanceOf(InsufficientDiskSpaceError);

    expect(installs(androidDriver)).toEqual([]);
    expect(installs(iosDriver)).toEqual(["27.0"]);
    iosDriver.releaseInstalls();
    await flush();
    expect(first.result()).toEqual({ outcome: "installed", version: "27.0" });
  });

  it("records an install in the registry with platform, version and the driver's receipt, and the record survives a reload", async () => {
    const harness = await createHarness();
    harness.clock.advance(2_000);

    await harness.installer.install(ios("27.0"));
    const reloaded = await Registry.load({
      clock: harness.clock,
      eventBus: harness.bus,
      filesystem: harness.stateFilesystem,
      idGenerator: { generate: () => "id" },
      statePath,
    });

    const expected = [
      {
        installedAt: 3_000,
        platform: "ios",
        receipt: { install: "1", version: "27.0" },
        version: "27.0",
      },
    ];
    expect(harness.registry.snapshot.components).toEqual(expected);
    expect(reloaded.snapshot.components).toEqual(expected);
  });

  it("stores no record and emits component.installed with alreadyPresent when an install of newest finds the newest runtime already there", async () => {
    const harness = await createHarness();

    await expect(harness.installer.install(ios("latest"))).resolves.toEqual({
      outcome: "already-installed",
      version: "26.5",
    });
    expect(installs(harness.ios)).toEqual(["latest"]);
    expect(harness.registry.snapshot.components).toEqual([]);
    expect(harness.events.at(-1)).toEqual({
      event: "component.installed",
      payload: {
        alreadyPresent: true,
        componentId: "latest",
        durationMs: 0,
        platform: "ios",
        version: "26.5",
      },
    });
  });

  it("fails a call still waiting when downloads.timeoutMs has passed since it arrived, without calling its driver", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0")).catch(() => undefined);
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    harness.clock.advance(timeoutMs);
    await flush();

    expect(waiting.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    // Nothing is ahead of it any more, and its install still never reaches the driver.
    harness.ios.releaseInstalls();
    await flush();
    expect(harness.ios.calls.map((call) => call.arguments[0])).not.toContain("28.0");
  });

  it("aborts the install of a call that waited for half its budget when the other half has passed, not a full budget later", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    await flush();
    harness.clock.advance(1);
    const behind = track(harness.installer.install(ios("28.0")));
    await flush();
    // Half its budget spent waiting; then the install ahead ends and its own starts.
    harness.clock.advance(timeoutMs / 2);
    harness.ios.releaseInstalls();
    harness.ios.holdInstalls();
    await flush();
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);

    harness.clock.advance(timeoutMs / 2 - 1);
    await flush();
    expect(behind.settled()).toBe(false);
    harness.clock.advance(1);
    await flush();
    expect(behind.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.installed",
      "component.install-started",
      "component.install-failed",
    ]);
  });

  it("aborts a running install at the deadline of the oldest call joined to it, and fails a call that joined later at that moment", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const oldest = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(10_000);
    const later = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(timeoutMs - 10_000);
    await flush();

    const timedOut = new ComponentInstallTimeoutError("ios", "27.0", timeoutMs);
    expect(oldest.error()).toEqual(timedOut);
    expect(later.error()).toEqual(timedOut);
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.install-failed",
    ]);
  });

  // Every call has the same budget, so a waiting call's deadline never falls before that of the
  // oldest call on the install running ahead of it. Firing only the waiting call's timer is what
  // shows its expiry touches nothing but its own call and its own install.
  it("leaves the install running ahead of a waiting call alone when that call times out", async () => {
    const harness = await createHarness({ clock: new ManualClock() });
    harness.ios.holdInstalls();

    const ahead = track(harness.installer.install(ios("27.0")));
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    (harness.clock as ManualClock).fire(1);
    await flush();
    expect(waiting.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    harness.ios.releaseInstalls();
    await flush();

    expect(ahead.result()).toEqual({ outcome: "installed", version: "27.0" });
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.installed",
    ]);
  });

  it("starts no install for a waiting install whose only call timed out", async () => {
    const harness = await createHarness({ clock: new ManualClock() });
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    void harness.installer.install(ios("28.0")).catch(() => undefined);
    await flush();
    (harness.clock as ManualClock).fire(1);
    await flush();
    harness.ios.releaseInstalls();
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
  });

  it("gives the disk back when an install ends, so the next install that fits alone starts", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          componentFootprint: { bytes: 6 * gibibyte, path: "/volume" },
          platform: "ios",
        }),
      ],
      freeDiskBytes: 10 * gibibyte,
    });
    harness.ios.failOn("installComponent", 1, new DriverCrashError("xcodebuild failed"));

    await expect(harness.installer.install(ios("27.0"))).rejects.toThrow("xcodebuild failed");
    await expect(harness.installer.install(ios("28.0"))).resolves.toMatchObject({
      outcome: "installed",
    });
    await expect(harness.installer.install(ios("29.0"))).resolves.toMatchObject({
      outcome: "installed",
    });
    expect(harness.reservations.map((reservation) => reservation.released)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("keeps the deadline of a call that ended as not-needed from ending the install the other calls joined", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const notNeeded = track(
      harness.installer.install(ios("27.0", { stillNeeded: async () => false })),
    );
    harness.clock.advance(1);
    const needed = track(harness.installer.install(ios("27.0")));
    await flush();
    expect(notNeeded.result()).toEqual({ outcome: "not-needed" });
    expect(installs(harness.ios)).toEqual(["27.0"]);

    // The not-needed call's budget runs out here; the install belongs to the other call now.
    harness.clock.advance(timeoutMs - 1);
    await flush();
    expect(needed.settled()).toBe(false);
    harness.clock.advance(1);
    await flush();
    expect(needed.error()).toEqual(new ComponentInstallTimeoutError("ios", "27.0", timeoutMs));
  });

  it("starts a new install for a call that arrives while a timed-out install's driver is still returning, after it returns", async () => {
    let finishStubborn: (() => void) | undefined;
    class StubbornDriver extends FakeDriver {
      readonly started: string[] = [];

      override async installComponent(
        component: string,
        options: Parameters<FakeDriver["installComponent"]>[1],
      ) {
        this.started.push(component);
        if (this.started.length === 1) {
          // Ignores its signal, like an installer that takes a while to die.
          await new Promise<void>((resolve) => {
            finishStubborn = resolve;
          });
          throw new DriverCrashError("ended late");
        }
        return super.installComponent(component, options);
      }
    }
    const harness = await createHarness({
      drivers: (clock) => [new StubbornDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    const driver = harness.ios as StubbornDriver;

    const first = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(timeoutMs);
    await flush();
    expect(first.error()).toBeInstanceOf(ComponentInstallTimeoutError);
    const second = track(harness.installer.install(ios("27.0")));
    await flush();
    expect(driver.started).toEqual(["27.0"]);

    finishStubborn?.();
    await flush();
    expect(driver.started).toEqual(["27.0", "27.0"]);
    expect(second.result()).toEqual({ outcome: "installed", version: "27.0" });
  });

  it("rejects only the call whose stillNeeded throws, and installs for the others joined to it", async () => {
    const harness = await createHarness();
    const failure = new Error("resolve failed");
    // An install ahead keeps all three waiting, so each reaches the front with its check.
    harness.ios.holdInstalls();
    void harness.installer.install(ios("28.0"));
    await flush();
    harness.ios.releaseInstalls();

    const [plain, throwing, notNeeded] = await Promise.allSettled([
      harness.installer.install(ios("27.0")),
      harness.installer.install(
        ios("27.0", {
          stillNeeded: async () => {
            throw failure;
          },
        }),
      ),
      harness.installer.install(ios("27.0", { stillNeeded: async () => false })),
    ]);

    expect(plain).toEqual({
      status: "fulfilled",
      value: { outcome: "installed", version: "27.0" },
    });
    expect(throwing).toEqual({ reason: failure, status: "rejected" });
    expect(notNeeded).toEqual({ status: "fulfilled", value: { outcome: "not-needed" } });
    expect(installs(harness.ios)).toEqual(["28.0", "27.0"]);
  });

  it("keeps a throwing progress callback from reaching the install or the other calls", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, installProgress: [50], platform: "ios" }),
      ],
    });
    const heard: ComponentInstallerProgress[] = [];

    const [throwing, listening] = await Promise.allSettled([
      harness.installer.install(
        ios("27.0", {
          onProgress: () => {
            throw new Error("observer broke");
          },
        }),
      ),
      harness.installer.install(ios("27.0", { onProgress: (report) => heard.push(report) })),
    ]);

    expect(throwing).toMatchObject({ status: "fulfilled" });
    expect(listening).toMatchObject({ status: "fulfilled" });
    expect(heard).toEqual([{ stage: "downloading" }, { percent: 50, stage: "downloading" }]);
  });

  it.each([
    ["checking whether the component is installed", "findComponent"],
    ["reserving disk", "diskFree"],
  ] as const)(
    "starts no install when the only call ran out of budget while the installer was %s",
    async (_step, slow) => {
      const harness = await createHarness({
        drivers: (clock) => [
          new FakeDriver({
            availableOsVersions: [],
            clock,
            latencyMs: slow === "findComponent" ? { findComponent: timeoutMs + 1 } : {},
            platform: "ios",
          }),
        ],
        filesystem: (clock) => ({
          diskFree: async () => {
            if (slow === "diskFree") {
              await new Promise<void>((resolve) => clock.setTimer(timeoutMs + 1, resolve));
            }
            return Number.MAX_SAFE_INTEGER;
          },
        }),
      });

      const call = track(harness.installer.install(ios("27.0")));
      await flush();
      harness.clock.advance(timeoutMs);
      await flush();
      expect(call.error()).toBeInstanceOf(ComponentInstallTimeoutError);
      harness.clock.advance(1);
      await flush();

      expect(installs(harness.ios)).toEqual([]);
      expect(harness.events).toEqual([]);
      // Nothing reserved once the call is gone; a reservation already taken is given back.
      expect(harness.reservations).toEqual(
        slow === "findComponent" ? [] : [{ bytes: 0, released: true }],
      );
    },
  );

  it("resolves close only once the running driver call has returned", async () => {
    let finishStubborn: (() => void) | undefined;
    class StubbornDriver extends FakeDriver {
      override async installComponent(): ReturnType<FakeDriver["installComponent"]> {
        // Ignores its signal, like an installer that takes a while to die.
        await new Promise<void>((resolve) => {
          finishStubborn = resolve;
        });
        throw new DriverCrashError("ended late");
      }
    }
    const harness = await createHarness({
      drivers: (clock) => [new StubbornDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });

    void harness.installer.install(ios("27.0")).catch(() => undefined);
    await flush();
    const closing = track(harness.installer.close());
    await flush();
    expect(closing.settled()).toBe(false);

    finishStubborn?.();
    await flush();
    expect(closing.settled()).toBe(true);
  });

  it("fails only the call whose budget runs out while a finished install's record is written, and installs for the rest", async () => {
    // A gate the test opens by hand, standing in for other registry writes ahead of the record.
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const harness = await createHarness({
      decisions: {
        run: async <Result>(operation: () => Result | Promise<Result>) => {
          await gate;
          return operation();
        },
      },
    });

    const oldest = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(1);
    const later = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(timeoutMs - 1);
    await flush();
    expect(oldest.error()).toEqual(new ComponentInstallTimeoutError("ios", "27.0", timeoutMs));
    expect(later.settled()).toBe(false);

    openGate?.();
    await flush();
    expect(later.result()).toEqual({ outcome: "installed", version: "27.0" });
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.installed",
    ]);
  });

  it("aborts the running install and rejects the waiting calls on close", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const running = track(harness.installer.install(ios("27.0")));
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    await harness.installer.close();
    await flush();

    expect(running.error()).toBeInstanceOf(ComponentInstallerClosedError);
    expect(waiting.error()).toBeInstanceOf(ComponentInstallerClosedError);
    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.install-failed",
    ]);
    await expect(harness.installer.install(ios("29.0"))).rejects.toBeInstanceOf(
      ComponentInstallerClosedError,
    );
  });
});

describe("ComponentInstaller.inProgress", () => {
  it("lists an install at the front of its queue that is still checking whether it is needed as waiting", async () => {
    const harness = await createHarness();

    void harness.installer.install(ios("27.0", { stillNeeded: () => new Promise(() => {}) }));
    await flush();

    expect(harness.installer.inProgress()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "waiting", waiters: 1 },
    ]);
    expect(installs(harness.ios)).toEqual([]);
  });

  it("lists an install whose driver returned and whose record is being written as downloading", async () => {
    const harness = await createHarness({
      // A gate that never opens: the record write waits behind it.
      decisions: { run: () => new Promise(() => {}) },
    });

    void harness.installer.install(ios("27.0"));
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(harness.installer.inProgress()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 1 },
    ]);
  });

  it("does not list a waiting install once its only call has timed out", async () => {
    const harness = await createHarness({ clock: new ManualClock() });
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    expect(harness.installer.inProgress().map((install) => install.component)).toEqual([
      "27.0",
      "28.0",
    ]);
    // Timer 1 is the budget of the call for 28.0.
    (harness.clock as ManualClock).fire(1);
    await flush();

    expect(waiting.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    expect(harness.installer.inProgress().map((install) => install.component)).toEqual(["27.0"]);
  });

  it("lists the 16 oldest installs across platforms, oldest first, when more are in progress", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: [], clock, platform: "android" }),
      ],
    });
    for (const driver of harness.drivers) driver.holdInstalls();

    // Alternating platforms, so the oldest are not the first ones of any one queue.
    for (let index = 0; index < 20; index += 1) {
      const platform = index % 2 === 0 ? "ios" : "android";
      void harness.installer.install({ component: `c${String(index)}`, platform });
      harness.clock.advance(1_000);
    }
    await flush();

    expect(harness.installer.inProgress().map((install) => install.component)).toEqual(
      Array.from({ length: 16 }, (_, index) => `c${String(index)}`),
    );
  });
});

/** A fake whose `listComponents` answers with exactly what a test lists. */
class ListingDriver extends FakeDriver {
  constructor(
    clock: FakeClock,
    platform: "ios" | "android",
    private readonly listing: readonly DriverComponent[],
  ) {
    super({ availableOsVersions: [], clock, platform });
  }

  override listComponents(): Promise<readonly DriverComponent[]> {
    return Promise.resolve(this.listing);
  }
}

async function addDevice(
  registry: Registry,
  platform: "ios" | "android",
  osVersion: string,
): Promise<string> {
  const device = await registry.registerDevice({
    driverData: {},
    driverDeviceId: `${platform}-${osVersion}-${String(registry.snapshot.devices.length)}`,
    provisionDuration: 0,
    spec: { model: "Phone", osVersion, platform },
  });
  return device.id;
}

describe("ComponentInstaller.list", () => {
  it("lists a component Simlock installed with installedBySimlock true and the time its record was written", async () => {
    const harness = await createHarness({
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    harness.clock.advance(4_000);

    await harness.installer.install(ios("27.0"));

    expect(await harness.installer.list()).toEqual([
      {
        devices: 0,
        foreignDevices: 0,
        installedAt: 5_000,
        installedBySimlock: true,
        platform: "ios",
        version: "27.0",
      },
    ]);
  });

  it("lists a component that was on the machine before with installedBySimlock false and no installedAt", async () => {
    const harness = await createHarness();

    expect(await harness.installer.list()).toEqual([
      {
        devices: 0,
        foreignDevices: 0,
        installedBySimlock: false,
        platform: "ios",
        version: "26.5",
      },
    ]);
  });

  it("marks nothing as Simlock's for a record of that platform and version whose receipt no longer equals the installed one", async () => {
    const harness = await createHarness();
    await harness.registry.recordComponent({
      installedAt: 1_000,
      platform: "ios",
      receipt: { install: "1", version: "26.5" },
      version: "26.5",
    });

    const [listed] = await harness.installer.list();

    expect(listed).toMatchObject({ installedBySimlock: false, version: "26.5" });
    expect(listed).not.toHaveProperty("installedAt");
  });

  it("does not take a record of another platform with an equal receipt as proof", async () => {
    const harness = await createHarness();
    await harness.registry.recordComponent({
      installedAt: 1_000,
      platform: "android",
      receipt: { preinstalled: "26.5" },
      version: "26.5",
    });

    const [listed] = await harness.installer.list();

    expect(listed).toMatchObject({ installedBySimlock: false, platform: "ios" });
  });

  it("counts registry devices of that platform and version, and not deleted ones", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: ["26.5", "27.0"], clock, platform: "ios" }),
      ],
    });
    await addDevice(harness.registry, "ios", "26.5");
    await addDevice(harness.registry, "ios", "26.5");
    const deleted = await addDevice(harness.registry, "ios", "26.5");
    await harness.registry.markDeviceMissing(deleted, "test");
    await addDevice(harness.registry, "ios", "27.0");
    // Same version string on the other platform: not a device of this component.
    await addDevice(harness.registry, "android", "26.5");

    const listed = await harness.installer.list();

    expect(listed.map(({ devices, version }) => ({ devices, version }))).toEqual([
      { devices: 2, version: "26.5" },
      { devices: 1, version: "27.0" },
    ]);
  });

  it("shows the devices of a version on both of its variants", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new ListingDriver(clock, "android", [
          {
            foreignDevices: 0,
            receipt: { image: "a" },
            variant: "google_apis/arm64-v8a",
            version: "35",
          },
          {
            foreignDevices: 0,
            receipt: { image: "b" },
            variant: "default/arm64-v8a",
            version: "35",
          },
        ]),
      ],
    });
    await addDevice(harness.registry, "android", "35");
    await addDevice(harness.registry, "android", "35");

    const listed = await harness.installer.list();

    expect(listed.map(({ devices, variant }) => ({ devices, variant }))).toEqual([
      { devices: 2, variant: "default/arm64-v8a" },
      { devices: 2, variant: "google_apis/arm64-v8a" },
    ]);
  });

  it("carries the driver's size, variant and foreign devices through unread", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new ListingDriver(clock, "ios", [
          {
            foreignDevices: 3,
            receipt: { image: "x" },
            sizeBytes: 9 * gibibyte,
            variant: "23A343",
            version: "26.0",
          },
        ]),
      ],
    });

    expect(await harness.installer.list()).toEqual([
      {
        devices: 0,
        foreignDevices: 3,
        installedBySimlock: false,
        platform: "ios",
        sizeBytes: 9 * gibibyte,
        variant: "23A343",
        version: "26.0",
      },
    ]);
  });

  it("orders by platform, then version as numbers, then variant", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new ListingDriver(clock, "ios", [
          { foreignDevices: 0, receipt: { r: "1" }, version: "26.4" },
          { foreignDevices: 0, receipt: { r: "2" }, version: "9.3" },
        ]),
        new ListingDriver(clock, "android", [
          { foreignDevices: 0, receipt: { r: "3" }, variant: "z", version: "35" },
          { foreignDevices: 0, receipt: { r: "4" }, variant: "a", version: "35" },
          { foreignDevices: 0, receipt: { r: "5" }, variant: "a", version: "9" },
        ]),
      ],
    });

    const listed = await harness.installer.list();

    expect(listed.map(({ platform, variant, version }) => [platform, version, variant])).toEqual([
      ["android", "9", "a"],
      ["android", "35", "a"],
      ["android", "35", "z"],
      ["ios", "9.3", undefined],
      ["ios", "26.4", undefined],
    ]);
  });

  it("asks only the named platform's driver when given a platform", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }),
      ],
    });

    const listed = await harness.installer.list("android");

    expect(listed.map((component) => component.platform)).toEqual(["android"]);
    expect(harness.ios.calls.some((call) => call.operation === "listComponents")).toBe(false);
  });

  it("leaves out a driver whose listing rejects, logs why, and still lists the other platform", async () => {
    const warnings: { readonly message: string; readonly fields: unknown }[] = [];
    const logger: Logger = {
      child: () => logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message, fields) => {
        warnings.push({ fields, message });
      },
    };
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }),
      ],
      logger,
    });
    harness.ios.failOn("listComponents", 1, new DriverCrashError("simctl runtime list failed"));

    const listed = await harness.installer.list();

    expect(listed.map((component) => [component.platform, component.version])).toEqual([
      ["android", "35"],
    ]);
    expect(warnings).toEqual([
      {
        fields: { error: "DriverCrashError: simctl runtime list failed", platform: "ios" },
        message: "A driver could not list its installed components",
      },
    ]);
  });

  it("starts no install, takes no reservation and emits no event", async () => {
    const harness = await createHarness();

    await harness.installer.list();

    expect(installs(harness.ios)).toEqual([]);
    expect(harness.reservations).toEqual([]);
    expect(harness.events).toEqual([]);
  });
});
