import { afterEach, expect, it, describe } from "vitest";
import { DriverCrashError } from "../../core/index.js";
import { ScriptedProcessRunner } from "../../ports/index.js";
import { deviceRoot } from "./test-slim.js";
import {
  Image,
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  defaultSetInvocation,
  defaultSetListed,
  image,
  imagesListed,
  listFixture,
  listFixtureAfterDownload,
  listInvocation,
  runtimeListInvocation,
  scopedRunners,
} from "./test-index.js";

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, `${deviceRoot}/sources`]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver listComponents()", () => {
  it("lists one entry per iOS runtime image with its version, size and build, and no entry for another platform's runtime", async () => {
    const runner = new ScriptedProcessRunner([
      imagesListed([
        image("18.4", "22E238", { sizeBytes: 8_963_458_461 }),
        image("26.0", "23A343", { sizeBytes: 9_100_000_000 }),
        image("11.4", "22T250", {
          platform: "com.apple.platform.watchsimulator",
          runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-11-4",
        }),
      ]),
      defaultSetListed({}),
    ]);
    const driver = await createDriver(runner);

    await expect(driver.listComponents()).resolves.toEqual([
      {
        foreignDevices: 0,
        receipt: { build: "22E238", image: "IMG-18.4-22E238" },
        sizeBytes: 8_963_458_461,
        variant: "22E238",
        version: "18.4",
      },
      {
        foreignDevices: 0,
        receipt: { build: "23A343", image: "IMG-26.0-23A343" },
        sizeBytes: 9_100_000_000,
        variant: "23A343",
        version: "26.0",
      },
    ]);
  });

  it("counts a device in the default device set that has lastUsedAt and uses an image's runtime as foreign, and reads no device in Simlock's own set for it", async () => {
    const used = image("18.4", "22E238");
    const unused = image("26.0", "23A343");
    // why: The scripted runner refuses any call it was not given, so a `simctl --set <root> list`
    // would fail this test: only the default set is read.
    const runner = new ScriptedProcessRunner([
      imagesListed([used, unused]),
      defaultSetListed({ [used.runtime]: 2, "com.apple.CoreSimulator.SimRuntime.iOS-17-5": 1 }),
    ]);
    const driver = await createDriver(runner);

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices, version }) => ({ foreignDevices, version }))).toEqual([
      { foreignDevices: 2, version: "18.4" },
      { foreignDevices: 0, version: "26.0" },
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      runtimeListInvocation.args,
      defaultSetInvocation.args,
    ]);
  });

  it("does not count a device in the default device set without lastUsedAt, such as the ones macOS creates when a runtime install ends (#241)", async () => {
    const fresh = image("18.6", "22G86");
    const runner = new ScriptedProcessRunner([
      imagesListed([fresh]),
      // why: What a runtime install leaves on Xcode 26.4.1: about eleven never-booted simulators of
      // it. One more the user has booted is the only one that counts.
      defaultSetListed({ [fresh.runtime]: { unused: 11, used: 1 } }),
    ]);
    const driver = await createDriver(runner);

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices }) => foreignDevices)).toEqual([1]);
  });

  it("counts a default-set entry that is not a device object as a user, so an unreadable entry never unblocks a removal (#241)", async () => {
    const fresh = image("18.6", "22G86");
    const runner = new ScriptedProcessRunner([
      imagesListed([fresh]),
      {
        match: defaultSetInvocation,
        result: {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            devices: { [fresh.runtime]: ["garbled", null, { name: "fresh", udid: "U-1" }] },
          }),
        },
      },
    ]);
    const driver = await createDriver(runner);

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices }) => foreignDevices)).toEqual([2]);
  });

  it("lists a runtime with the receipt installComponent returned for it, and runs no installer to list", async () => {
    const before = [
      { build: "22E238", id: "IMG-184", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-4" },
    ];
    const after = [
      ...before,
      { build: "22G86", id: "IMG-186", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6" },
    ];
    const asImages = (entries: typeof after): Image[] =>
      entries.map((entry) => ({
        ...entry,
        version: entry.runtime.endsWith("18-6") ? "18.6" : "18.4",
      }));
    const listed = (stdout: string) => ({
      match: listInvocation,
      result: { code: 0, stderr: "", stdout },
    });
    const runner = new ScriptedProcessRunner([
      listed(listFixture),
      imagesListed(asImages(before)),
      {
        match: {
          args: ["-downloadPlatform", "iOS", "-buildVersion", "18.6"],
          command: "xcodebuild",
        },
      },
      listed(listFixtureAfterDownload),
      imagesListed(asImages(after)),
      imagesListed(asImages(after)),
      defaultSetListed({}),
    ]);
    const driver = await createDriver(runner);
    const installed = await driver.installComponent("18.6", {
      onProgress: () => undefined,
      signal: new AbortController().signal,
    });
    const callsBeforeListing = runner.calls.length;

    const components = await driver.listComponents();

    expect(components.find((component) => component.version === "18.6")?.receipt).toEqual(
      installed.receipt,
    );
    expect(runner.calls.slice(callsBeforeListing).map((call) => call.command)).toEqual([
      "xcrun",
      "xcrun",
    ]);
  });

  it("leaves out an image with no version or no platform, leaves out a size that is not a byte count, and counts no device under a runtime that lists none", async () => {
    const ios = "com.apple.platform.iphonesimulator";
    const runtimeList = {
      "IMG-A": {
        build: "22E238",
        identifier: "IMG-A",
        platformIdentifier: ios,
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
        sizeBytes: -1,
        version: "18.4",
      },
      "IMG-B": {
        build: "23A343",
        identifier: "IMG-B",
        platformIdentifier: ios,
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        sizeBytes: 1.5,
      },
      "IMG-C": {
        build: "23A344",
        identifier: "IMG-C",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
        sizeBytes: 10,
        version: "26.1",
      },
    };
    const runner = new ScriptedProcessRunner([
      {
        match: runtimeListInvocation,
        result: { code: 0, stderr: "", stdout: JSON.stringify(runtimeList) },
      },
      {
        match: defaultSetInvocation,
        result: {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-4": "not a list" },
          }),
        },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.listComponents()).resolves.toEqual([
      {
        foreignDevices: 0,
        receipt: { build: "22E238", image: "IMG-A" },
        variant: "22E238",
        version: "18.4",
      },
    ]);
  });

  it("rejects with DriverCrashError when the default device set answers with something that is not JSON", async () => {
    const runner = new ScriptedProcessRunner([
      imagesListed([image("18.4", "22E238")]),
      { match: defaultSetInvocation, result: { code: 0, stderr: "", stdout: "not json" } },
    ]);
    const driver = await createDriver(runner);

    const error = await driver.listComponents().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DriverCrashError);
    expect((error as Error).message).toContain("Could not parse simctl device list");
  });

  it("rejects with DriverCrashError when the default device set answers JSON with no devices map", async () => {
    const runner = new ScriptedProcessRunner([
      imagesListed([image("18.4", "22E238")]),
      { match: defaultSetInvocation, result: { code: 0, stderr: "", stdout: "{}" } },
    ]);
    const driver = await createDriver(runner);

    const error = await driver.listComponents().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DriverCrashError);
    expect((error as Error).message).toBe("Invalid simctl device list JSON");
  });

  it("rejects when the default device set cannot be read, rather than report no foreign devices", async () => {
    const runner = new ScriptedProcessRunner([
      imagesListed([image("18.4", "22E238")]),
      {
        match: defaultSetInvocation,
        result: { code: 1, stderr: "CoreSimulator is down", stdout: "" },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.listComponents()).rejects.toBeInstanceOf(DriverCrashError);
  });
});
