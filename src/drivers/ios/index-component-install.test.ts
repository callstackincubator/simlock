import { afterEach, expect, describe, it } from "vitest";
import { RuntimeMissingError, DriverCrashError } from "../../core/index.js";
import { ScriptedProcessRunner, FakeClock, MemoryFilesystem } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { deviceRoot, simctl, instanceId } from "./test-slim.js";
import {
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  listFixture,
  listFixtureAfterDownload,
  listInvocation,
  pairingFixture,
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

describe("IosSimctlDriver", () => {
  describe("component install", () => {
    const runtimeListInvocation = simctl("runtime", "list", "-j");
    const imagesBefore = [
      { build: "22E238", id: "IMG-184", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-4" },
      { build: "23F77", id: "IMG-265", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5" },
    ];
    const imagesAfter = [
      ...imagesBefore,
      { build: "22G86", id: "IMG-186", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6" },
    ];

    function listed(stdout: string) {
      return { match: listInvocation, result: { code: 0, stderr: "", stdout } };
    }

    function imagesListed(images: readonly { build: string; id: string; runtime: string }[]) {
      const stdout = JSON.stringify(
        Object.fromEntries(
          images.map((image) => [
            image.id,
            {
              build: image.build,
              identifier: image.id,
              runtimeIdentifier: image.runtime,
              state: "Ready",
            },
          ]),
        ),
      );
      return { match: runtimeListInvocation, result: { code: 0, stderr: "", stdout } };
    }

    function xcodebuild(args: readonly string[], extra: object = {}) {
      return { match: { args: [...args], command: "xcodebuild" }, ...extra };
    }

    function install(
      driver: IosSimctlDriver,
      component: string,
      options: { onProgress?: (progress: unknown) => void; signal?: AbortSignal } = {},
    ) {
      return driver.installComponent(component, {
        onProgress: options.onProgress ?? (() => undefined),
        signal: options.signal ?? new AbortController().signal,
      });
    }

    it("installs an exact version with -buildVersion and no timeout of its own, verifies it in a fresh read, and reports it installed with its image and build", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"]),
        listed(listFixtureAfterDownload),
        imagesListed(imagesAfter),
      ]);
      const driver = await createDriver(runner);

      await expect(install(driver, "18.6")).resolves.toEqual({
        outcome: "installed",
        receipt: { build: "22G86", image: "IMG-186" },
        version: "18.6",
      });
      const xcodebuildCall = runner.calls.find((call) => call.command === "xcodebuild");
      expect(xcodebuildCall?.options).toEqual({ lineEnd: "carriage-return-too" });
    });

    it("reports already-installed when the runtime the installer leaves was there before it ran", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS"]),
        listed(listFixture),
        imagesListed(imagesBefore),
      ]);
      const driver = await createDriver(runner);

      await expect(install(driver, "latest")).resolves.toEqual({
        outcome: "already-installed",
        receipt: { build: "23F77", image: "IMG-265" },
        version: "26.5",
      });
    });

    it("installs a bare major with -buildVersion <major> and reports the newest runtime of it", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18"]),
        listed(listFixtureAfterDownload),
        imagesListed(imagesAfter),
      ]);
      const driver = await createDriver(runner);

      await expect(install(driver, "18")).resolves.toMatchObject({
        outcome: "installed",
        version: "18.6",
      });
    });

    it("refuses a version below the download floor without running anything", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      const result = await install(driver, "13.0").catch((error: unknown) => error);

      expect(result).toBeInstanceOf(RuntimeMissingError);
      expect(result).toMatchObject({
        downloadable: false,
        message: expect.stringContaining("16.0"),
      });
      expect(runner.calls).toEqual([]);
    });

    it("fails when xcodebuild exits 0 but the runtime is still not installed", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"]),
        listed(listFixture),
        imagesListed(imagesBefore),
      ]);
      const driver = await createDriver(runner);

      const result = await install(driver, "18.6").catch((error: unknown) => error);

      expect(result).toBeInstanceOf(DriverCrashError);
      expect((result as Error).message).toContain("iOS 18.6 is still not installed");
    });

    it("fails with xcodebuild's own output when it exits non-zero", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"], {
          result: { code: 1, stderr: "no network", stdout: "" },
        }),
      ]);
      const driver = await createDriver(runner);

      const result = await install(driver, "18.6").catch((error: unknown) => error);

      expect(result).toBeInstanceOf(DriverCrashError);
      expect((result as Error).message).toContain("no network");
    });

    it("fails with a non-downloadable RuntimeMissingError when Apple no longer offers the version", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"], {
          result: { code: 70, stderr: "iOS 18.6 is not available for download.", stdout: "" },
        }),
      ]);
      const driver = await createDriver(runner);

      const result = await install(driver, "18.6").catch((error: unknown) => error);

      expect(result).toBeInstanceOf(RuntimeMissingError);
      expect(result).toMatchObject({ downloadable: false });
    });

    it("reports each percentage xcodebuild prints as progress, and nothing for a line without one", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"], {
          stdoutLines: [
            "Downloading iOS 18.6 Simulator (22G86): 12.5% (1 GB of 8 GB)",
            "Verifying download",
            "Downloading iOS 18.6 Simulator (22G86): 100.0% (8 GB of 8 GB)",
          ],
        }),
        listed(listFixtureAfterDownload),
        imagesListed(imagesAfter),
      ]);
      const driver = await createDriver(runner);
      const progress: unknown[] = [];

      await install(driver, "18.6", { onProgress: (report) => progress.push(report) });

      expect(progress).toEqual([
        { percent: 12.5, stage: "downloading" },
        { percent: 100, stage: "downloading" },
      ]);
    });

    it("ends xcodebuild when the signal fires, and fails the install", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"], { hangs: true }),
      ]);
      const driver = await createDriver(runner);
      const controller = new AbortController();

      let error: unknown;
      void install(driver, "18.6", { signal: controller.signal }).catch((caught: unknown) => {
        error = caught;
      });
      for (let tick = 0; tick < 50 && runner.handles.length < 3; tick += 1) {
        await Promise.resolve();
      }
      expect(runner.handles).toHaveLength(3);
      controller.abort();
      for (let tick = 0; tick < 50 && error === undefined; tick += 1) {
        await Promise.resolve();
      }

      // why: Settled within a few microtasks of the signal: the kill ended it, not a timer.
      expect(error).toBeInstanceOf(DriverCrashError);
      expect((error as Error).message).toContain("was ended before it finished");
    });

    it.each([
      [
        "an exact version",
        { physical: false, model: "iPhone 7", osVersion: "13.0", platform: "ios" as const },
        "13.0",
      ],
      ["no version", { model: "iPhone 7", platform: "ios" as const }, "15"],
    ])(
      "reports a missing runtime below the download floor as not downloadable, for %s",
      async (_case, request, named) => {
        const runner = new ScriptedProcessRunner([listed(pairingFixture)]);
        const driver = await createDriver(runner);

        const result = await driver.resolveSpec(request).catch((error: unknown) => error);

        expect(result).toBeInstanceOf(RuntimeMissingError);
        expect(result).toMatchObject({
          component: undefined,
          downloadable: false,
          message: expect.stringContaining(`iOS ${named} predates`),
        });
      },
    );

    it("tells the requester to name an exact release when the download of a bare major fails", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18"], {
          result: { code: 1, stderr: "no such build", stdout: "" },
        }),
      ]);
      const driver = await createDriver(runner);

      const result = await install(driver, "18").catch((error: unknown) => error);

      expect(result).toBeInstanceOf(DriverCrashError);
      expect((result as Error).message).toMatch(/tried 18.*no such build.*pass --os <version>/);
    });

    it("names the image whose build matches the runtime's when two images provide one runtime identifier", async () => {
      const twoBuilds = JSON.stringify({
        devicetypes: (JSON.parse(listFixture) as { devicetypes: unknown }).devicetypes,
        runtimes: [
          {
            buildversion: "23F79",
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
            isAvailable: true,
            name: "iOS 26.5",
            supportedDeviceTypes: [],
            version: "26.5",
          },
        ],
      });
      const runner = new ScriptedProcessRunner([
        listed(twoBuilds),
        imagesListed([
          { build: "23F77", id: "IMG-OLD", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5" },
          { build: "23F79", id: "IMG-NEW", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5" },
        ]),
      ]);
      const driver = await createDriver(runner);

      await expect(driver.findComponent("26.5")).resolves.toEqual({
        receipt: { build: "23F79", image: "IMG-NEW" },
        version: "26.5",
      });
    });

    it("kills xcodebuild with SIGKILL when it ignores the SIGTERM its signal sent", async () => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        xcodebuild(["-downloadPlatform", "iOS", "-buildVersion", "18.6"], {
          hangs: true,
          ignoresSigterm: true,
        }),
      ]);
      const driver = await createDriver(runner, clock);
      const controller = new AbortController();

      let error: unknown;
      void install(driver, "18.6", { signal: controller.signal }).catch((caught: unknown) => {
        error = caught;
      });
      for (let tick = 0; tick < 50 && runner.handles.length < 3; tick += 1) {
        await Promise.resolve();
      }
      controller.abort();
      for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
      expect(error).toBeUndefined();

      clock.advance(10_000);
      for (let tick = 0; tick < 50 && error === undefined; tick += 1) {
        await Promise.resolve();
      }
      expect(error).toBeInstanceOf(DriverCrashError);
    });

    it("finds an installed version with its receipt, and nothing for latest, a bare major or a missing version", async () => {
      const runner = new ScriptedProcessRunner([
        listed(listFixture),
        imagesListed(imagesBefore),
        listed(listFixture),
        imagesListed(imagesBefore),
        listed(listFixture),
        imagesListed(imagesBefore),
        listed(listFixture),
        imagesListed(imagesBefore),
      ]);
      const driver = await createDriver(runner);

      await expect(driver.findComponent("26.5")).resolves.toEqual({
        receipt: { build: "23F77", image: "IMG-265" },
        version: "26.5",
      });
      await expect(driver.findComponent("latest")).resolves.toBeUndefined();
      await expect(driver.findComponent("26")).resolves.toBeUndefined();
      await expect(driver.findComponent("18.6")).resolves.toBeUndefined();
      expect(runner.calls.map((call) => call.command)).not.toContain("xcodebuild");
    });

    it("states 8 GiB on the configured CoreSimulator volume as the footprint of one install", async () => {
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot: "/Users/agent/Library/Developer/CoreSimulator",
        driverConfig: { deviceRoot },
        filesystem: new MemoryFilesystem(),
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner([]),
        simlockHome: "/home/.simlock",
      });

      expect(driver.componentFootprint).toEqual({
        bytes: 8 * 1024 ** 3,
        path: "/Users/agent/Library/Developer/CoreSimulator",
      });
    });
  });
});
