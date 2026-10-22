import { describe, expect, it } from "vitest";

import {
  DriverCrashError,
  type PhysicalDriverDevice,
  PassthroughRefusedError,
  UnknownModelError,
} from "./index.js";
import { FakeDriver, FakeDriverUnknownDeviceError } from "./fake-driver.js";
import * as publicIndex from "./index.js";
import * as testing from "./testing.js";
import { FakeClock } from "../ports/index.js";

const VIRTUAL_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;

type FakeDriverOptions = ConstructorParameters<typeof FakeDriver>[0];

function passthroughFake(options: Partial<FakeDriverOptions>): FakeDriver {
  return new FakeDriver({ clock: new FakeClock(), platform: "ios", ...options });
}

describe("FakeDriver", () => {
  it("resolves the scripted passthrough command, handing it the tool, device, args and context", async () => {
    const seen: unknown[] = [];
    const driver = passthroughFake({
      passthrough: (tool: string, device: unknown, args: readonly string[], context?: unknown) => {
        seen.push({ args, context, device, tool });
        return { args: ["--set", "/root", ...args], command: "xcrun", env: {} };
      },
      passthroughTools: ["simctl"],
    });

    await expect(
      driver.passthrough("simctl", VIRTUAL_DEVICE, ["list"], { hasTerminal: false }),
    ).resolves.toEqual({ args: ["--set", "/root", "list"], command: "xcrun", env: {} });
    expect(seen).toEqual([
      { args: ["list"], context: { hasTerminal: false }, device: VIRTUAL_DEVICE, tool: "simctl" },
    ]);
  });

  it("rejects a scripted refusal with its PassthroughRefusedError instead of throwing it", async () => {
    const driver = passthroughFake({
      passthrough: () => {
        throw new PassthroughRefusedError("simctl", "Refusing `simlock simctl delete`");
      },
      passthroughTools: ["simctl"],
    });

    const returned = driver.passthrough("simctl", undefined, ["delete"]);

    await expect(returned).rejects.toBeInstanceOf(PassthroughRefusedError);
    await expect(returned).rejects.toMatchObject({ tool: "simctl" });
  });

  it("rejects with PassthroughRefusedError naming the tool when no passthrough was scripted", async () => {
    const driver = passthroughFake({ passthroughTools: ["adb"] });

    await expect(driver.passthrough("adb", undefined, ["devices"])).rejects.toMatchObject({
      name: "PassthroughRefusedError",
      tool: "adb",
    });
  });

  it("is exported from core/testing.ts and not from the public index", () => {
    expect(testing.FakeDriver).toBe(FakeDriver);
    expect("FakeDriver" in publicIndex).toBe(false);
    expect("FakeDriverUnknownDeviceError" in publicIndex).toBe(false);
  });

  it("surfaces a scripted typed failure on the selected provision call", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "android" });
    const crash = new DriverCrashError("emulator exited");
    driver.failOn("provision", 2, crash);
    const spec = {
      physical: false,
      model: "Pixel 10",
      osVersion: "36",
      platform: "android",
    } as const;

    await expect(driver.provision(spec)).resolves.toMatchObject({ deviceId: "fake-android-1" });
    await expect(driver.provision(spec)).rejects.toBe(crash);
  });

  it("returns configured estimates", () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      estimateMs: { boot: 20, provision: 10, reclaim: 30 },
      platform: "ios",
    });
    const spec = {
      physical: false,
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    } as const;

    expect(driver.estimate({ operation: "provision" }, spec)).toBe(10);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(20);
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(30);
  });

  it("estimates a reclaim of a physical spec at 90 000 ms at both clean levels, and a virtual spec as configured", () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      estimateMs: { boot: 20, provision: 10, reclaim: 30 },
      fullCleanReclaimEstimateMs: 45,
      platform: "ios",
    });
    const virtual = {
      physical: false,
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const physical = {
      class: "phone",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      physical: true,
      platform: "ios",
    } as const;

    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, virtual)).toBe(30);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, virtual)).toBe(45);
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, physical)).toBe(90_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, physical)).toBe(90_000);
  });

  it("answers uninstall for the reclaim strategy of a physical device, and what it was given for a virtual one", () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      platform: "ios",
      reclaimStrategy: "erase",
    });

    expect(driver.reclaimStrategy(VIRTUAL_DEVICE, { clean: "standard" })).toBe("erase");
    const physical: PhysicalDriverDevice = {
      address: "",
      deviceId: "udid",
      driverData: {},
      enrolledApps: [],
      physical: true,
    };

    expect(driver.reclaimStrategy(physical, { clean: "standard" })).toBe("uninstall");
  });

  it("reclaims a physical device nobody scripted, reporting every enrolled app as missing", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    const physical: PhysicalDriverDevice = {
      address: "",
      deviceId: "udid",
      driverData: {},
      enrolledApps: ["com.example.kept"],
      physical: true,
    };

    await expect(driver.reclaim(physical, { clean: "standard" })).resolves.toEqual({
      missingApps: ["com.example.kept"],
      state: "ready",
      strategy: "uninstall",
    });
  });

  it("holds a presence read until released when any one of the IDs it asks about is held", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    driver.setPhysicalPresence("A", true);
    driver.holdPresenceReads("A");
    let answer: readonly unknown[] | undefined;
    const read = driver.listPresentPhysical(["B", "A"]).then((entries) => {
      answer = entries;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(answer).toBeUndefined();

    driver.releasePresenceReads();
    await read;
    expect(answer).toEqual([
      { driverDeviceId: "B", present: false, reason: "not-present" },
      { driverDeviceId: "A", osVersion: "1.0", present: true },
    ]);
  });

  it("answers a presence read at once after the held reads were released", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    driver.setPhysicalPresence("A", true);
    driver.holdPresenceReads("A");
    driver.releasePresenceReads();

    const answer = await Promise.race([
      driver.listPresentPhysical(["A"]),
      new Promise((resolve) => setTimeout(() => resolve("held"), 25)),
    ]);

    expect(answer).toEqual([{ driverDeviceId: "A", osVersion: "1.0", present: true }]);
  });

  it("reports the scripted reason of a not-present device and the scripted OS version of a present one", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    driver.setPhysicalPresence("A", false, { reason: "locked" });
    driver.setPhysicalPresence("B", true, { osVersion: "18.5" });
    driver.setPhysicalPresence("C", false);

    await expect(driver.listPresentPhysical(["A", "B", "C"])).resolves.toEqual([
      { driverDeviceId: "A", present: false, reason: "locked" },
      { driverDeviceId: "B", osVersion: "18.5", present: true },
      { driverDeviceId: "C", present: false, reason: "not-present" },
    ]);
  });

  it("forgets a scripted OS version when the device is scripted present again without one", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    driver.setPhysicalPresence("A", true, { osVersion: "18.5" });
    driver.setPhysicalPresence("A", true);

    await expect(driver.listPresentPhysical(["A"])).resolves.toEqual([
      { driverDeviceId: "A", osVersion: "1.0", present: true },
    ]);
  });

  it.each([
    ["a prepare boot of a slim-spec device", { mode: "slim", purpose: "prepare" }, "slim"],
    ["a recover boot of a slim-spec device", { mode: "slim", purpose: "recover" }, "full"],
    ["a prepare boot of a full-spec device", { mode: "full", purpose: "prepare" }, "full"],
  ] as const)(
    "a slimming fake reports the mode the iOS driver would for %s",
    async (_label, options, reported) => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(),
        platform: "ios",
        slimmableOsVersions: ["26.5"],
      });
      const device = await driver.provision({
        physical: false,
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await expect(driver.makeReady(device, options)).resolves.toMatchObject({ mode: reported });
    },
  );

  it("records calls, refuses a missing runtime until it is installed, and enforces known-device destruction", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16"],
      platform: "ios",
    });

    await expect(
      driver.resolveSpec({ model: "Unknown", osVersion: "26.5", platform: "ios" }),
    ).rejects.toBeInstanceOf(UnknownModelError);
    await expect(
      driver.resolveSpec({ model: "iPhone 16", osVersion: "27", platform: "ios" }),
    ).rejects.toMatchObject({ component: "27", downloadable: true, name: "RuntimeMissingError" });
    await expect(
      driver.installComponent("27", {
        onProgress: () => undefined,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ outcome: "installed", version: "27" });
    await expect(
      driver.resolveSpec({ model: "iPhone 16", osVersion: "27", platform: "ios" }),
    ).resolves.toEqual({ physical: false, model: "iPhone 16", osVersion: "27", platform: "ios" });

    const device = await driver.provision({
      physical: false,
      model: "iPhone 16",
      osVersion: "27",
      platform: "ios",
    });
    await driver.destroy(device);
    await expect(driver.destroy(device)).rejects.toBeInstanceOf(FakeDriverUnknownDeviceError);

    expect(driver.calls.map((call) => call.operation)).toEqual([
      "resolveSpec",
      "resolveSpec",
      "installComponent",
      "resolveSpec",
      "provision",
      "destroy",
      "destroy",
    ]);
  });

  it("reports its known models and installed runtimes, marking the newest as default", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16", "iPhone 17 Pro"],
      platform: "ios",
    });

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: "26.5",
      modelAliases: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 16": ["18.4", "26.5"], "iPhone 17 Pro": ["18.4", "26.5"] },
      models: ["iPhone 16", "iPhone 17 Pro"],
      runtimes: ["18.4", "26.5"],
    });
  });

  it("pairs a model with only the runtimes its modelRuntimes option names", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16", "iPhone XS"],
      modelRuntimes: { "iPhone XS": ["18.4"] },
      platform: "ios",
    });

    expect((await driver.listCatalog()).modelRuntimes).toEqual({
      "iPhone 16": ["18.4", "26.5"],
      "iPhone XS": ["18.4"],
    });
  });

  it("reports the other names and images its options name, and no images field without them", async () => {
    const options = {
      availableOsVersions: ["35"],
      clock: new FakeClock(),
      knownModels: ["Pixel 8"],
      platform: "android" as const,
    };
    const scripted = new FakeDriver({
      ...options,
      images: [{ abi: "x86_64", runtime: "35", tag: "default" }],
      modelAliases: { "Pixel 8": ["pixel_8"] },
    });

    await expect(scripted.listCatalog()).resolves.toMatchObject({
      images: [{ abi: "x86_64", runtime: "35", tag: "default" }],
      modelAliases: { "Pixel 8": ["pixel_8"] },
    });
    expect(await new FakeDriver(options).listCatalog()).not.toHaveProperty("images");
  });

  it("reports the built-in preference lists its options name, and none without them", () => {
    const options = { clock: new FakeClock(), platform: "ios" as const };

    expect(
      new FakeDriver({ ...options, defaultModels: { phone: ["iPhone 17"] } }).defaultModels,
    ).toEqual({ phone: ["iPhone 17"] });
    expect(new FakeDriver(options).defaultModels).toEqual({});
  });

  it("reads a scripted physical device by any of its IDs, answering with the first as canonical and defaults for what is unset", async () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      physicalDevices: [
        { apps: ["a"], class: "tablet", ids: ["UDID", "ALIAS"], model: "iPad", osVersion: "18.5" },
        { ids: ["PLAIN"] },
      ],
      platform: "ios",
    });

    await expect(driver.inspectPhysical("ALIAS")).resolves.toEqual({
      apps: ["a"],
      class: "tablet",
      driverDeviceId: "UDID",
      enrollable: true,
      model: "iPad",
      osVersion: "18.5",
    });
    await expect(driver.inspectPhysical("PLAIN")).resolves.toEqual({
      apps: [],
      class: "phone",
      driverDeviceId: "PLAIN",
      enrollable: true,
      model: "Fake Phone",
      osVersion: "1.0",
    });
  });

  it("refuses an ID no scripted device lists as not-connected, and a scripted refusal with its reason and message", async () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      physicalDevices: [
        { ids: ["LOCKED"], refusal: { message: "locked: unlock it", reason: "locked" } },
      ],
      platform: "ios",
    });

    await expect(driver.inspectPhysical("NOPE")).resolves.toEqual({
      enrollable: false,
      message: "NOPE is not connected",
      reason: "not-connected",
    });
    await expect(driver.inspectPhysical("LOCKED")).resolves.toEqual({
      enrollable: false,
      message: "locked: unlock it",
      reason: "locked",
    });
    await expect(
      new FakeDriver({ clock: new FakeClock(), platform: "ios" }).inspectPhysical("X"),
    ).resolves.toMatchObject({ reason: "not-connected" });
  });

  it("reads the devices setPhysicalDevices replaced, not the ones its options named, and logs the call", async () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      physicalDevices: [{ ids: ["OLD"] }],
      platform: "ios",
    });

    driver.setPhysicalDevices([{ ids: ["NEW"] }]);

    await expect(driver.inspectPhysical("OLD")).resolves.toMatchObject({ enrollable: false });
    await expect(driver.inspectPhysical("NEW")).resolves.toMatchObject({ enrollable: true });
    expect(driver.calls.map((call) => [call.operation, call.arguments])).toEqual([
      ["inspectPhysical", ["OLD"]],
      ["inspectPhysical", ["NEW"]],
    ]);
  });
});
