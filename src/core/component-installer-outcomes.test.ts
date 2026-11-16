import { describe, expect, it } from "vitest";
import { DriverCrashError, InsufficientDiskSpaceError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { loadTestRegistry } from "./testing.js";
import {
  gibibyte,
  createHarness,
  installs,
  flush,
  track,
  ios,
} from "./test-component-installer.js";

describe("ComponentInstaller", () => {
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
    const reloaded = await loadTestRegistry({
      clock: harness.clock,
      eventBus: harness.bus,
      idGenerator: { generate: () => "id" },
      state: harness.state,
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
});
