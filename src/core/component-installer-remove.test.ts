import { describe, expect, it } from "vitest";
import { type Logger, MemoryFilesystem } from "../ports/index.js";
import {
  ComponentBeingRemovedError,
  ComponentInstaller,
  ComponentInstallerClosedError,
  type ComponentInstallerProgress,
} from "./component-installer.js";
import {
  ComponentBusyError,
  ComponentInUseError,
  ComponentNotOwnedError,
  DiskSpaceGuard,
  DriverCrashError,
} from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import type { DeviceRecord } from "./domain.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  timeoutMs,
  createHarness,
  installs,
  flush,
  track,
  ios,
} from "./test-component-installer.js";

describe("ComponentInstaller.remove", () => {
  async function withSimlockInstall(
    options: {
      readonly componentSizes?: Record<string, number>;
      readonly foreignDevices?: Record<string, number>;
    } = {},
  ) {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, platform: "ios", ...options }),
      ],
    });
    await harness.installer.install(ios("27.0"));
    harness.events.length = 0;
    return harness;
  }

  function removals(driver: FakeDriver): readonly unknown[] {
    return driver.calls
      .filter((call) => call.operation === "removeComponent")
      .map((call) => call.arguments[0]);
  }

  const removeIos = (version: string, extra: { readonly dryRun?: boolean } = {}) => ({
    platform: "ios" as const,
    requesterId: "tok_admin",
    version,
    ...extra,
  });

  it("removes a component with a record and no users, deletes its record, and list no longer shows it", async () => {
    const harness = await withSimlockInstall({ componentSizes: { "27.0": 7_000_000_000 } });
    const [record] = harness.registry.snapshot.components;

    await expect(harness.installer.remove(removeIos("27.0"))).resolves.toEqual({
      outcome: "removed",
      sizeBytes: 7_000_000_000,
    });

    expect(removals(harness.ios)).toEqual([record?.receipt]);
    expect(harness.registry.snapshot.components).toEqual([]);
    expect(await harness.installer.list()).toEqual([]);
    expect(harness.events).toEqual([
      {
        event: "component.removed",
        payload: {
          componentId: "27.0",
          platform: "ios",
          requesterId: "tok_admin",
          sizeBytes: 7_000_000_000,
          version: "27.0",
        },
      },
    ]);
  });

  it("carries the driver's residue into the answer and the event", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          platform: "ios",
          removalResidue: "the download stays",
        }),
      ],
    });
    await harness.installer.install(ios("27.0"));

    await expect(harness.installer.remove(removeIos("27.0"))).resolves.toEqual({
      outcome: "removed",
      residue: "the download stays",
    });
    expect(harness.events.at(-1)).toMatchObject({
      event: "component.removed",
      payload: { residue: "the download stays" },
    });
  });

  it("refuses a component with no record with ComponentNotOwnedError and never calls removeComponent", async () => {
    const harness = await createHarness();

    await expect(harness.installer.remove(removeIos("26.5"))).rejects.toBeInstanceOf(
      ComponentNotOwnedError,
    );
    expect(removals(harness.ios)).toEqual([]);
    expect(await harness.installer.list()).toMatchObject([{ version: "26.5" }]);
  });

  it("refuses a record whose version is no longer installed saying none is installed, and a record whose version was installed again saying that one is not Simlock's, in a removal and a dry run alike", async () => {
    const harness = await createHarness();
    for (const version of ["25.0", "26.5"]) {
      await harness.registry.recordComponent({
        installedAt: 1_000,
        platform: "ios",
        receipt: { install: "1", version },
        version,
      });
    }

    for (const dryRun of [false, true]) {
      await expect(harness.installer.remove(removeIos("25.0", { dryRun }))).rejects.toMatchObject({
        message: "No ios 25.0 is installed now, so there is nothing to remove",
        name: "ComponentNotOwnedError",
      });
      await expect(harness.installer.remove(removeIos("26.5", { dryRun }))).rejects.toMatchObject({
        message:
          "The ios 26.5 installed now is not the one Simlock installed, so Simlock will not remove it",
        name: "ComponentNotOwnedError",
      });
    }
    expect(removals(harness.ios)).toEqual([]);
    expect(harness.registry.snapshot.components).toContainEqual(
      expect.objectContaining({ platform: "ios", version: "26.5" }),
    );
  });

  it("removes a component whose receipt matches the record even when the listing names its version differently", async () => {
    const harness = await createHarness();
    const receipt = { preinstalled: "26.5" };
    await harness.registry.recordComponent({
      installedAt: 1_000,
      platform: "ios",
      receipt,
      version: "26.5.0",
    });

    await expect(harness.installer.remove(removeIos("26.5.0"))).resolves.toMatchObject({
      outcome: "removed",
    });
    expect(removals(harness.ios)).toEqual([receipt]);
  });

  it.each(["provisioning", "ready", "leased", "reclaiming", "quarantined", "shutdown"] as const)(
    "refuses a component a %s registry device uses with ComponentInUseError naming the count, and never calls removeComponent",
    async (state) => {
      const device: DeviceRecord = {
        physical: false,
        createdAt: 0,
        driverData: {},
        driverDeviceId: "udid-1",
        id: "dev_1",
        mode: "full",
        spec: { physical: false, model: "Phone", osVersion: "27.0", platform: "ios" },
        state,
      };
      const harness = await withSimlockInstall();
      const installer = new ComponentInstaller({
        clock: harness.clock,
        decisions: new SerializedDecision(),
        diskSpace: new DiskSpaceGuard(),
        drivers: new DriverCatalog(harness.drivers),
        eventBus: harness.bus,
        filesystem: new MemoryFilesystem(),
        registry: {
          deleteComponent: (platform, version) =>
            harness.registry.deleteComponent(platform, version),
          recordComponent: (record) => harness.registry.recordComponent(record),
          get snapshot() {
            return { ...harness.registry.snapshot, devices: [device], virtualDevices: [device] };
          },
        },
        timeoutMs,
      });

      const error = await installer.remove(removeIos("27.0")).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ComponentInUseError);
      expect(error).toMatchObject({ devices: 1, foreignDevices: 0 });
      expect(removals(harness.ios)).toEqual([]);
      expect(harness.registry.snapshot.components).toHaveLength(1);
    },
  );

  it("does not count a physical device on the runtime's OS as using it, so removal is not refused for it", async () => {
    const physical: DeviceRecord = {
      createdAt: 0,
      driverData: {},
      driverDeviceId: "00008110-001A2B3C4D5E",
      enrolledApps: [],
      id: "dev_physical",
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "27.0",
        physical: true,
        platform: "ios",
      },
      state: "ready",
    };
    const harness = await withSimlockInstall();
    const installer = new ComponentInstaller({
      clock: harness.clock,
      decisions: new SerializedDecision(),
      diskSpace: new DiskSpaceGuard(),
      drivers: new DriverCatalog(harness.drivers),
      eventBus: harness.bus,
      filesystem: new MemoryFilesystem(),
      registry: {
        deleteComponent: (platform, version) => harness.registry.deleteComponent(platform, version),
        recordComponent: (record) => harness.registry.recordComponent(record),
        get snapshot() {
          return { ...harness.registry.snapshot, devices: [physical], virtualDevices: [] };
        },
      },
      timeoutMs,
    });

    await expect(installer.remove(removeIos("27.0"))).resolves.toMatchObject({
      outcome: "removed",
    });
    expect(removals(harness.ios)).toHaveLength(1);
  });

  it("refuses a component a foreign device uses with ComponentInUseError naming the count, and never calls removeComponent", async () => {
    const harness = await withSimlockInstall({ foreignDevices: { "27.0": 2 } });

    const error = await harness.installer.remove(removeIos("27.0")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ComponentInUseError);
    expect(error).toMatchObject({ devices: 0, foreignDevices: 2 });
    expect(removals(harness.ios)).toEqual([]);
  });

  it("refuses, and never calls removeComponent, when the driver's listing rejects", async () => {
    const harness = await withSimlockInstall();
    harness.ios.failOn("listComponents", 1, new DriverCrashError("default set unreadable"));

    await expect(harness.installer.remove(removeIos("27.0"))).rejects.toThrow(
      "default set unreadable",
    );
    expect(removals(harness.ios)).toEqual([]);
    expect(harness.registry.snapshot.components).toHaveLength(1);
  });

  it("refuses with ComponentInUseError while a device is being provisioned on it and has no record yet", async () => {
    const harness = await withSimlockInstall();
    const release = harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" });

    await expect(harness.installer.remove(removeIos("27.0"))).rejects.toMatchObject({
      devices: 1,
      foreignDevices: 0,
    });
    await expect(
      harness.installer.remove(removeIos("27.0", { dryRun: true })),
    ).rejects.toMatchObject({ devices: 1, foreignDevices: 0, name: "ComponentInUseError" });
    expect(removals(harness.ios)).toEqual([]);

    release();
    await expect(harness.installer.remove(removeIos("27.0"))).resolves.toMatchObject({
      outcome: "removed",
    });
  });

  it("answers a dry run with would-remove and the size, calls no driver verb that changes anything, and keeps the record", async () => {
    const harness = await withSimlockInstall({ componentSizes: { "27.0": 7_000_000_000 } });
    const before = harness.ios.calls.length;

    await expect(harness.installer.remove(removeIos("27.0", { dryRun: true }))).resolves.toEqual({
      outcome: "would-remove",
      sizeBytes: 7_000_000_000,
    });

    expect(harness.ios.calls.slice(before).map((call) => call.operation)).toEqual([
      "listComponents",
    ]);
    expect(harness.registry.snapshot.components).toHaveLength(1);
    expect(harness.events).toEqual([]);
    expect(await harness.installer.list()).toMatchObject([
      { installedBySimlock: true, version: "27.0" },
    ]);
  });

  it.each([false, true])(
    "refuses with ComponentBusyError while an install is running on that platform (dry run: %s)",
    async (dryRun) => {
      const harness = await withSimlockInstall();
      harness.ios.holdInstalls();
      const install = track(harness.installer.install(ios("28.0")));
      await flush();
      expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);

      await expect(harness.installer.remove(removeIos("27.0", { dryRun }))).rejects.toBeInstanceOf(
        ComponentBusyError,
      );
      expect(removals(harness.ios)).toEqual([]);

      harness.ios.releaseInstalls();
      await flush();
      expect(install.result()).toMatchObject({ outcome: "installed" });
    },
  );

  it("refuses with ComponentBusyError while an install waits on that platform, before its driver runs", async () => {
    const harness = await withSimlockInstall();
    void harness.installer
      .install(ios("28.0", { stillNeeded: () => new Promise<boolean>(() => undefined) }))
      .catch(() => undefined);
    await flush();
    expect(harness.installer.inProgress()).toMatchObject([{ component: "28.0", state: "waiting" }]);
    expect(installs(harness.ios)).toEqual(["27.0"]);

    await expect(harness.installer.remove(removeIos("27.0"))).rejects.toBeInstanceOf(
      ComponentBusyError,
    );
    expect(removals(harness.ios)).toEqual([]);
  });

  it("counts Simlock's devices again inside the decision gate, and refuses one claimed after the listing", async () => {
    const decisions = new SerializedDecision();
    const harness = await createHarness({
      decisions,
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    await harness.installer.install(ios("27.0"));
    // why: Something else holds the gate, so the removal's listing and first count pass before it
    // gets its turn there.
    let releaseGate!: () => void;
    void decisions.run(
      () =>
        new Promise<void>((resolve) => {
          releaseGate = resolve;
        }),
    );
    const removal = track(harness.installer.remove(removeIos("27.0")));
    await flush();
    expect(harness.ios.calls.filter((call) => call.operation === "listComponents")).toHaveLength(1);
    expect(removal.settled()).toBe(false);

    harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" });
    releaseGate();
    await flush();

    expect(removal.error()).toBeInstanceOf(ComponentInUseError);
    expect(removal.error()).toMatchObject({ devices: 1 });
    expect(removals(harness.ios)).toEqual([]);
  });

  it("starts an install that arrives during a removal only after the removal has ended", async () => {
    const harness = await withSimlockInstall();
    harness.ios.holdRemovals();
    const removal = track(harness.installer.remove(removeIos("27.0")));
    await flush();
    expect(removals(harness.ios)).toHaveLength(1);

    const progress: ComponentInstallerProgress[] = [];
    const install = track(
      harness.installer.install(ios("28.0", { onProgress: (heard) => progress.push(heard) })),
    );
    await flush();
    expect(progress).toEqual([{ stage: "waiting" }]);
    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(harness.ios.calls.filter((call) => call.operation === "findComponent")).toHaveLength(1);
    expect(harness.installer.inProgress()).toMatchObject([{ component: "28.0", state: "waiting" }]);

    harness.ios.releaseRemovals();
    await flush();

    expect(removal.result()).toMatchObject({ outcome: "removed" });
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);
    expect(install.result()).toMatchObject({ outcome: "installed", version: "28.0" });
  });

  it("refuses a second removal on the platform while one runs with ComponentBusyError", async () => {
    const harness = await createHarness({
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    await harness.installer.install(ios("27.0"));
    await harness.installer.install(ios("28.0"));
    harness.ios.holdRemovals();
    const first = track(harness.installer.remove(removeIos("27.0")));
    await flush();

    await expect(harness.installer.remove(removeIos("28.0"))).rejects.toBeInstanceOf(
      ComponentBusyError,
    );

    harness.ios.releaseRemovals();
    await flush();
    expect(first.result()).toMatchObject({ outcome: "removed" });
  });

  it("refuses every device claimed on the component while it is being removed, and none once the removal has settled", async () => {
    const harness = await withSimlockInstall();
    harness.ios.holdRemovals();
    const removal = track(harness.installer.remove(removeIos("27.0")));
    await flush();

    expect(() => harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" })).toThrow(
      ComponentBeingRemovedError,
    );
    expect(() =>
      harness.installer.claimProvision({ osVersion: "26.0", platform: "ios" }),
    ).not.toThrow();

    harness.ios.releaseRemovals();
    await flush();
    expect(removal.settled()).toBe(true);
    expect(() =>
      harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" }),
    ).not.toThrow();
  });

  it("keeps the record, clears the mark and emits no component.removed when the driver fails the removal", async () => {
    const harness = await withSimlockInstall();
    harness.ios.failOn("removeComponent", 1, new DriverCrashError("simctl runtime delete failed"));

    await expect(harness.installer.remove(removeIos("27.0"))).rejects.toThrow(
      "simctl runtime delete failed",
    );

    expect(harness.registry.snapshot.components).toMatchObject([{ version: "27.0" }]);
    expect(harness.events).toEqual([]);
    expect(() =>
      harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" }),
    ).not.toThrow();
    await expect(harness.installer.install(ios("28.0"))).resolves.toMatchObject({
      outcome: "installed",
    });
  });

  it("refuses with ComponentInstallerClosedError, removing nothing, when the daemon stops while the listing is read", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          latencyMs: { listComponents: 10 },
          platform: "ios",
        }),
      ],
    });
    await harness.installer.install(ios("27.0"));
    const removal = track(harness.installer.remove(removeIos("27.0")));
    await flush();
    expect(harness.ios.calls.filter((call) => call.operation === "listComponents")).toHaveLength(1);

    await harness.installer.close();
    harness.clock.advance(10);
    await flush();

    expect(removal.error()).toBeInstanceOf(ComponentInstallerClosedError);
    expect(removals(harness.ios)).toEqual([]);
    expect(harness.registry.snapshot.components).toHaveLength(1);
  });

  it("ends one claim per release however often that release is called", async () => {
    const harness = await withSimlockInstall();
    const first = harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" });
    harness.installer.claimProvision({ osVersion: "27.0", platform: "ios" });

    first();
    first();

    expect(await harness.installer.list()).toMatchObject([{ devices: 1, version: "27.0" }]);
  });

  it("refuses with ComponentInstallerClosedError once the daemon has stopped, without reading the listing", async () => {
    const harness = await withSimlockInstall();
    await harness.installer.close();
    const before = harness.ios.calls.length;

    await expect(harness.installer.remove(removeIos("27.0"))).rejects.toBeInstanceOf(
      ComponentInstallerClosedError,
    );
    expect(harness.ios.calls.slice(before)).toEqual([]);
  });

  it("resolves close only once a running removal's driver call has returned", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          // why: A delay the abort does not cut short, as a platform tool that is slow to exit.
          latencyMs: { removeComponent: 10 },
          platform: "ios",
        }),
      ],
    });
    await harness.installer.install(ios("27.0"));
    void harness.installer.remove(removeIos("27.0")).catch(() => undefined);
    await flush();
    expect(removals(harness.ios)).toHaveLength(1);

    const closing = track(harness.installer.close());
    await flush();
    expect(closing.settled()).toBe(false);

    harness.clock.advance(10);
    await flush();
    expect(closing.settled()).toBe(true);
  });

  it("logs a failed removal with who asked, after the driver was called", async () => {
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
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
      logger,
    });
    await harness.installer.install(ios("27.0"));
    harness.ios.failOn("removeComponent", 1, new DriverCrashError("simctl runtime delete failed"));

    await expect(harness.installer.remove(removeIos("27.0"))).rejects.toThrow(
      "simctl runtime delete failed",
    );

    expect(warnings).toEqual([
      {
        fields: {
          error: "DriverCrashError: simctl runtime delete failed",
          platform: "ios",
          requesterId: "tok_admin",
          version: "27.0",
        },
        message: "A component removal failed; Simlock's record of it is kept",
      },
    ]);
  });

  it("ends a running removal on close with ComponentInstallerClosedError, and keeps the record", async () => {
    const harness = await withSimlockInstall();
    harness.ios.holdRemovals();
    const removal = track(harness.installer.remove(removeIos("27.0")));
    await flush();

    await harness.installer.close();
    await flush();

    expect(removal.error()).toBeInstanceOf(ComponentInstallerClosedError);
    expect(harness.registry.snapshot.components).toHaveLength(1);
    expect(harness.events).toEqual([]);
  });
});
