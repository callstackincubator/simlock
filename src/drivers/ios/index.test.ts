import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BootTimeoutError,
  DriverCrashError,
  InsufficientDiskSpaceError,
  RuntimeMissingError,
  UnknownModelError,
} from "../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  ScriptedProcessRunner,
  SystemClock,
  type Filesystem,
} from "../../ports/index.js";
import type { ComponentInstallDiagnostic } from "../diagnostics.js";
import { IosSimctlDriver } from "./index.js";

const listFixture = readFileSync(new URL("./fixtures/simctl-list.json", import.meta.url), "utf8");
const listDevicesFixture = readFileSync(
  new URL("./fixtures/simctl-list-devices.json", import.meta.url),
  "utf8",
);
// iPhone 16 pairs with both installed runtimes; iPhone Xs pairs only with the older one (iOS 26
// dropped it, mirroring real Xcode 27) and its range caps out at iOS 18.6; iPhone 7 caps out at
// iOS 15.0, below the 16.0 auto-download floor.
const pairingFixture = readFileSync(
  new URL("./fixtures/simctl-list-pairing.json", import.meta.url),
  "utf8",
);
// Same catalog as `listFixture`, plus an iOS 18.6 runtime that has just finished downloading --
// stands in for the re-scanned catalog `resolveSpec` reads after a successful `xcodebuild` call.
const listFixtureAfterDownload = JSON.stringify({
  devicetypes: (JSON.parse(listFixture) as { devicetypes: unknown }).devicetypes,
  runtimes: [
    ...(JSON.parse(listFixture) as { runtimes: unknown[] }).runtimes,
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
      isAvailable: true,
      name: "iOS 18.6",
      supportedDeviceTypes: [
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16" },
      ],
      version: "18.6",
    },
  ],
});
const listInvocation = {
  command: "xcrun",
  args: ["simctl", "list", "-j", "devicetypes", "runtimes"],
} as const;
const listDevicesInvocation = {
  command: "xcrun",
  args: ["simctl", "list", "-j", "devices"],
} as const;
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const driverData = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "simlock-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;
const dataPath = `/Devices/${driverData.udid}/data`;
const durableMarkPath = `/Devices/${driverData.udid}/simlock-mark.json`;
const erasableMarkPath = `${dataPath}/simlock-mark.json`;

function deviceListResponse(state: string): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { name: driverData.name, udid: driverData.udid, state, dataPath },
      ],
    },
  });
}

describe("IosSimctlDriver", () => {
  it("resolves an exact model and requested installed runtime", async () => {
    const runner = scriptedListRunner();
    const driver = createDriver(runner);

    await expect(
      driver.resolveSpec(
        { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "18.4", platform: "ios" });
    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("selects the newest installed iOS runtime by default", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec({ model: "iPhone 16", platform: "ios" }, { allowDownload: false }),
    ).resolves.toEqual(spec);
  });

  it("matches model names case-insensitively while preserving the simctl name", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec(
        { model: "iphone 16", osVersion: "26.5", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual(spec);
  });

  it("rejects an unknown model, pointing at a newer Xcode", async () => {
    const driver = createDriver(scriptedListRunner());
    const result = await driver
      .resolveSpec({ model: "iPhone 99", platform: "ios" }, { allowDownload: false })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(UnknownModelError);
    expect(result).toMatchObject({ message: expect.stringContaining("newer Xcode") });
  });

  it("rejects malformed simctl catalog JSON without trusting partial data", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: '{"devicetypes":[]}' },
      },
    ]);

    await expect(
      createDriver(runner).resolveSpec(
        { model: "iPhone 16", platform: "ios" },
        { allowDownload: false },
      ),
    ).rejects.toBeInstanceOf(DriverCrashError);
  });

  it("rejects a missing runtime without downloading when downloads are not allowed, naming the fix", async () => {
    const runner = scriptedListRunner();
    const driver = createDriver(runner);
    const result = await driver
      .resolveSpec(
        { model: "iPhone 16", osVersion: "18.6", platform: "ios" },
        { allowDownload: false },
      )
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({
      message: expect.stringMatching(/18\.6/),
    });
    expect(result).toMatchObject({
      message: expect.stringMatching(/allow-download|downloads\.policy/),
    });
    // Never attempted a download: only the initial catalog list call happened.
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects an out-of-range OS version before ever considering a download", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: pairingFixture } },
    ]);
    const driver = createDriver(runner);

    const result = await driver
      .resolveSpec(
        { model: "iPhone Xs", osVersion: "26.5", platform: "ios" },
        { allowDownload: true },
      )
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({
      downloadable: false,
      message: expect.stringContaining("iPhone Xs supports iOS 12.0-18.6"),
    });
    // No xcodebuild (or any further simctl) call: out-of-range is checked before download logic.
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects an installed runtime whose supportedDeviceTypes omits the requested model, without ever calling simctl create", async () => {
    const catalog = JSON.stringify({
      devicetypes: [
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          maxRuntimeVersion: 16_777_215,
          minRuntimeVersion: 0,
          name: "iPhone 16",
        },
      ],
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
          isAvailable: true,
          name: "iOS 18.4",
          supportedDeviceTypes: [],
          version: "18.4",
        },
      ],
    });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: catalog } },
    ]);
    const driver = createDriver(runner);

    const result = await driver
      .resolveSpec(
        { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
        { allowDownload: true },
      )
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({
      downloadable: false,
      message: "iOS 18.4 is installed but does not support iPhone 16",
    });
    // Installed and in range, but not paired: no download attempted, no simctl create.
    expect(runner.calls).toHaveLength(1);
  });

  it("selects the newest installed runtime that actually pairs with the model, not the newest overall", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: pairingFixture } },
    ]);
    const driver = createDriver(runner);

    // iOS 26.5 is newer and installed, but only iOS 18.4 still lists iPhone Xs as supported.
    await expect(
      driver.resolveSpec({ model: "iPhone Xs", platform: "ios" }, { allowDownload: false }),
    ).resolves.toEqual({ model: "iPhone Xs", osVersion: "18.4", platform: "ios" });
  });

  it("refuses to auto-download a runtime older than the iOS 16.0 floor", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: pairingFixture } },
    ]);
    const driver = createDriver(runner);

    const result = await driver
      .resolveSpec(
        { model: "iPhone 7", osVersion: "13.0", platform: "ios" },
        { allowDownload: true },
      )
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({ downloadable: false, message: expect.stringContaining("16.0") });
    // Range check passed (13.0 is within iPhone 7's 9.0-15.0), but no xcodebuild call was made.
    expect(runner.calls).toHaveLength(1);
  });

  it("downloads a missing in-range runtime via xcodebuild and re-scans the catalog", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: {
          command: "xcodebuild",
          args: ["-downloadPlatform", "iOS", "-buildVersion", "18.6"],
        },
      },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixtureAfterDownload } },
    ]);
    const driver = createDriver(runner);

    await expect(
      driver.resolveSpec(
        { model: "iPhone 16", osVersion: "18.6", platform: "ios" },
        { allowDownload: true },
      ),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "18.6", platform: "ios" });
    expect(runner.calls.map((call) => call.command)).toEqual(["xcrun", "xcodebuild", "xcrun"]);
  });

  it("dedupes concurrent resolveSpec calls for the same missing runtime behind one xcodebuild invocation", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: {
          command: "xcodebuild",
          args: ["-downloadPlatform", "iOS", "-buildVersion", "18.6"],
        },
      },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixtureAfterDownload } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixtureAfterDownload } },
    ]);
    const driver = createDriver(runner);
    const request = { model: "iPhone 16", osVersion: "18.6", platform: "ios" } as const;

    const [first, second] = await Promise.all([
      driver.resolveSpec(request, { allowDownload: true }),
      driver.resolveSpec(request, { allowDownload: true }),
    ]);

    expect(first).toEqual({ model: "iPhone 16", osVersion: "18.6", platform: "ios" });
    expect(second).toEqual({ model: "iPhone 16", osVersion: "18.6", platform: "ios" });
    expect(runner.calls.filter((call) => call.command === "xcodebuild")).toHaveLength(1);
  });

  describe("component install diagnostics", () => {
    it("reports component-install-started then component-installed with a duration on a successful download", async () => {
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: {
            command: "xcodebuild",
            args: ["-downloadPlatform", "iOS", "-buildVersion", "18.6"],
          },
        },
        {
          match: listInvocation,
          result: { code: 0, stderr: "", stdout: listFixtureAfterDownload },
        },
      ]);
      const clock = new FakeClock();
      const diagnostics: ComponentInstallDiagnostic[] = [];
      const driver = createDriver(runner, clock, new MemoryFilesystem(), (diagnostic) =>
        diagnostics.push(diagnostic),
      );

      await driver.resolveSpec(
        { model: "iPhone 16", osVersion: "18.6", platform: "ios" },
        { allowDownload: true },
      );

      expect(diagnostics).toEqual([
        { componentId: "18.6", kind: "component-install-started" },
        { componentId: "18.6", durationMs: 0, kind: "component-installed" },
      ]);
    });

    it("reports component-install-failed with a stable error summary when xcodebuild fails", async () => {
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: {
            command: "xcodebuild",
            args: ["-downloadPlatform", "iOS", "-buildVersion", "18.6"],
          },
          result: { code: 1, stderr: "no network", stdout: "" },
        },
      ]);
      const diagnostics: ComponentInstallDiagnostic[] = [];
      const driver = createDriver(runner, new FakeClock(), new MemoryFilesystem(), (diagnostic) =>
        diagnostics.push(diagnostic),
      );

      await driver
        .resolveSpec(
          { model: "iPhone 16", osVersion: "18.6", platform: "ios" },
          { allowDownload: true },
        )
        .catch((error: unknown) => error);

      expect(diagnostics).toEqual([
        { componentId: "18.6", kind: "component-install-started" },
        {
          componentId: "18.6",
          durationMs: 0,
          error: expect.stringContaining("DriverCrashError:"),
          kind: "component-install-failed",
        },
      ]);
    });

    it('reports "latest" as the component id for an unbounded default-runtime download', async () => {
      // A device type with no upper bound (maxRuntimeVersion unbounded) but no currently
      // installed runtime lists it as supported -- forces the "no paired runtime, download
      // latest" branch rather than the exact-version one the other tests exercise.
      const unpairedCatalog = JSON.stringify({
        devicetypes: [
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
            maxRuntimeVersion: 16_777_215,
            minRuntimeVersion: 917_504,
            name: "iPhone 16",
          },
        ],
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
            isAvailable: true,
            name: "iOS 18.4",
            supportedDeviceTypes: [],
            version: "18.4",
          },
        ],
      });
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: unpairedCatalog } },
        { match: { command: "xcodebuild", args: ["-downloadPlatform", "iOS"] } },
        { match: listInvocation, result: { code: 0, stderr: "", stdout: unpairedCatalog } },
      ]);
      const diagnostics: ComponentInstallDiagnostic[] = [];
      const driver = createDriver(runner, new FakeClock(), new MemoryFilesystem(), (diagnostic) =>
        diagnostics.push(diagnostic),
      );

      await driver
        .resolveSpec({ model: "iPhone 16", platform: "ios" }, { allowDownload: true })
        .catch(() => undefined);

      expect(diagnostics[0]).toEqual({ componentId: "latest", kind: "component-install-started" });
    });

    it("fails disk preflight before ever invoking xcodebuild, and reports no diagnostic", async () => {
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      ]);
      const diagnostics: ComponentInstallDiagnostic[] = [];
      const filesystem = new MemoryFilesystem(1024);
      const driver = createDriver(runner, new FakeClock(), filesystem, (diagnostic) =>
        diagnostics.push(diagnostic),
      );

      const error = await driver
        .resolveSpec(
          { model: "iPhone 16", osVersion: "18.6", platform: "ios" },
          { allowDownload: true },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientDiskSpaceError);
      expect((error as Error).message).toMatch(/needs ~8\.0 GiB.*only 0\.0 GiB available/);
      // Only the initial catalog list happened: no xcodebuild invocation, no diagnostic.
      expect(runner.calls.map((call) => call.command)).toEqual(["xcrun"]);
      expect(diagnostics).toEqual([]);
    });

    it("surfaces a disk-preflight failure from the bounded-default download path as InsufficientDiskSpaceError, not DriverCrashError", async () => {
      // A device type with a finite max (bounded, unlike the "latest" test above) and no
      // installed runtime pairs with it -- forces the bounded-default download branch, whose
      // catch previously wrapped every failure (including this one) in a DriverCrashError. The
      // installed runtime below keeps the catalog non-empty (required to parse at all) without
      // pairing with the requested model.
      const catalog = JSON.stringify({
        devicetypes: [
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Xs",
            maxRuntimeVersion: 1_181_184,
            minRuntimeVersion: 786_432,
            name: "iPhone Xs",
          },
        ],
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
            isAvailable: true,
            name: "iOS 18.4",
            supportedDeviceTypes: [],
            version: "18.4",
          },
        ],
      });
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: catalog } },
      ]);
      const filesystem = new MemoryFilesystem(1024);
      const driver = createDriver(runner, new FakeClock(), filesystem);

      const error = await driver
        .resolveSpec({ model: "iPhone Xs", platform: "ios" }, { allowDownload: true })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientDiskSpaceError);
      // Only the initial catalog list happened: no xcodebuild invocation attempted.
      expect(runner.calls.map((call) => call.command)).toEqual(["xcrun"]);
    });

    it("checks disk space on the configured CoreSimulator volume, not the daemon's own working directory", async () => {
      class RecordingFilesystem extends MemoryFilesystem {
        readonly diskFreePaths: string[] = [];

        override async diskFree(path: string): Promise<number> {
          this.diskFreePaths.push(path);
          return super.diskFree(path);
        }
      }
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: {
            command: "xcodebuild",
            args: ["-downloadPlatform", "iOS", "-buildVersion", "18.6"],
          },
        },
        {
          match: listInvocation,
          result: { code: 0, stderr: "", stdout: listFixtureAfterDownload },
        },
      ]);
      const filesystem = new RecordingFilesystem();
      const driver = new IosSimctlDriver({
        clock: new FakeClock(),
        coreSimulatorRoot: "/Users/agent/Library/Developer/CoreSimulator",
        filesystem,
        idGenerator: { generate: () => "device-1" },
        processRunner: runner,
      });

      await driver.resolveSpec(
        { model: "iPhone 16", osVersion: "18.6", platform: "ios" },
        { allowDownload: true },
      );

      expect(filesystem.diskFreePaths).toEqual(["/Users/agent/Library/Developer/CoreSimulator"]);
    });
  });

  it("provisions with the exact simctl argv and returns opaque iOS driver data", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: {
          command: "xcrun",
          args: [
            "simctl",
            "create",
            "simlock-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const driver = createDriver(runner, new FakeClock(), filesystem);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );

    await expect(driver.provision(spec)).resolves.toEqual({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData,
    });
    expect(runner.calls).toEqual([
      { ...listInvocation, options: { timeoutMs: 30_000 } },
      {
        args: [
          "simctl",
          "create",
          "simlock-device-1",
          driverData.deviceTypeId,
          driverData.runtimeId,
        ],
        command: "xcrun",
        options: { timeoutMs: 30_000 },
      },
      { ...listDevicesInvocation, options: { timeoutMs: 30_000 } },
    ]);
  });

  it("surfaces simctl failures with stderr", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: {
          command: "xcrun",
          args: [
            "simctl",
            "create",
            "simlock-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 1, stderr: "Invalid runtime", stdout: "" },
      },
    ]);
    const driver = createDriver(runner);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );

    await expect(driver.provision(spec)).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Invalid runtime"),
        name: "DriverCrashError",
      }),
    );
  });

  it("boots then waits for bootstatus with the documented timeout", async () => {
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "boot", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "bootstatus", driverData.udid, "-b"] } },
    ]);

    await expect(
      createDriver(runner).makeReady({
        address: driverData.udid,
        deviceId: driverData.udid,
        driverData,
      }),
    ).resolves.toEqual({ address: driverData.udid, deviceId: driverData.udid, driverData });
    expect(runner.calls).toEqual([
      {
        args: ["simctl", "boot", driverData.udid],
        command: "xcrun",
        options: { timeoutMs: 30_000 },
      },
      {
        args: ["simctl", "bootstatus", driverData.udid, "-b"],
        command: "xcrun",
        options: { timeoutMs: 120_000 },
      },
    ]);
  });

  it("times out bootstatus and issues a best-effort shutdown", async () => {
    const clock = new FakeClock();
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "boot", driverData.udid] } },
      {
        hangs: true,
        match: { command: "xcrun", args: ["simctl", "bootstatus", driverData.udid, "-b"] },
      },
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
    ]);
    const ready = createDriver(runner, clock).makeReady({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData,
    });

    while (runner.calls.length < 2) {
      await Promise.resolve();
    }
    clock.advance(120_000);

    await expect(ready).rejects.toBeInstanceOf(BootTimeoutError);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "boot", driverData.udid],
      ["simctl", "bootstatus", driverData.udid, "-b"],
      ["simctl", "shutdown", driverData.udid],
    ]);
  });

  it("reclaims by tolerating an already-shutdown response, then erasing", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] },
        result: {
          code: 149,
          stderr: "Unable to shutdown device in current state: Shutdown",
          stdout: "",
        },
      },
      { match: { command: "xcrun", args: ["simctl", "erase", driverData.udid] } },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);

    await expect(
      createDriver(runner, new FakeClock(), filesystem).reclaim(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        { clean: "full" },
      ),
    ).resolves.toEqual({ state: "shutdown", strategy: "erase" });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "erase", driverData.udid],
      ["simctl", "list", "-j", "devices"],
    ]);
  });

  it("writes a fresh, different token on reclaim than the one written on provision", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: {
          command: "xcrun",
          args: [
            "simctl",
            "create",
            "simlock-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ],
        },
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "erase", driverData.udid] } },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const driver = createTokenDriver(runner, filesystem);
    await driver.resolveSpec(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      { allowDownload: false },
    );
    await driver.provision(spec);

    const provisionedDurable = JSON.parse(await filesystem.readFile(durableMarkPath)) as {
      token: string;
    };
    const provisionedErasable = JSON.parse(await filesystem.readFile(erasableMarkPath)) as {
      token: string;
    };
    expect(provisionedDurable.token).toBe(provisionedErasable.token);

    await driver.reclaim(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      { clean: "full" },
    );

    const reclaimedDurable = JSON.parse(await filesystem.readFile(durableMarkPath)) as {
      token: string;
    };
    const reclaimedErasable = JSON.parse(await filesystem.readFile(erasableMarkPath)) as {
      token: string;
    };
    expect(reclaimedDurable.token).toBe(reclaimedErasable.token);
    expect(reclaimedDurable.token).not.toBe(provisionedDurable.token);
  });

  it("shuts down before deleting and uses benchmark estimates", async () => {
    const runner = new ScriptedProcessRunner([
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "delete", driverData.udid] } },
    ]);
    const driver = createDriver(runner);

    await driver.destroy({ address: driverData.udid, deviceId: driverData.udid, driverData });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "delete", driverData.udid],
    ]);
    expect(driver.estimate({ operation: "provision" }, spec)).toBe(500);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(60_000);
  });

  it("prices reclaim as the erase it always runs, at either clean level", () => {
    const driver = createDriver(new ScriptedProcessRunner([]));

    // `reclaimStrategy` answers `erase` for both levels, so both must be priced as one --
    // and as tens of seconds, not the ~1s the estimate used to claim (#56).
    expect(driver.reclaimStrategy({ clean: "standard" })).toBe("erase");
    expect(driver.reclaimStrategy({ clean: "full" })).toBe("erase");
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(34_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, spec)).toBe(34_000);
  });

  it("lists resolvable models and installed runtimes, defaulting to the newest", async () => {
    const driver = createDriver(scriptedListRunner());

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: "26.5",
      models: ["iPhone 17 Pro", "iPhone 16", "iPhone 15 Pro"],
      runtimes: ["18.4", "26.5"],
    });
  });

  it("shells out to simctl exactly once per listCatalog call, reusing the catalog parse", async () => {
    const runner = scriptedListRunner();
    const driver = createDriver(runner);

    await driver.listCatalog();

    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("maps simctl device state to runState and filters to simlock- devices", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listDevicesInvocation, result: { code: 0, stderr: "", stdout: listDevicesFixture } },
    ]);
    const driver = createDriver(runner);

    const reality = await driver.listManaged();

    expect(
      reality.devices.map((device) => ({ deviceId: device.deviceId, runState: device.runState })),
    ).toEqual([
      { deviceId: "00000000-0000-0000-0000-000000000101", runState: "running" },
      { deviceId: "00000000-0000-0000-0000-000000000102", runState: "stopped" },
      { deviceId: "00000000-0000-0000-0000-000000000103", runState: "transitioning" },
      { deviceId: "00000000-0000-0000-0000-000000000104", runState: "transitioning" },
    ]);
  });

  it("populates processes from booted managed devices only", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listDevicesInvocation, result: { code: 0, stderr: "", stdout: listDevicesFixture } },
    ]);
    const driver = createDriver(runner);

    const reality = await driver.listManaged();

    expect(reality.processes).toEqual([
      expect.objectContaining({
        deviceId: "00000000-0000-0000-0000-000000000101",
        runState: "running",
      }),
    ]);
  });

  it("derives the data path from the cached devices root instead of re-listing", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
      { match: { command: "xcrun", args: ["simctl", "shutdown", driverData.udid] } },
      { match: { command: "xcrun", args: ["simctl", "erase", driverData.udid] } },
    ]);
    const driver = createDriver(runner, new FakeClock(), filesystem);

    await driver.listManaged();
    await driver.reclaim(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      { clean: "full" },
    );

    // `simctl list` costs ~260ms and reclaim runs on every release, so the
    // devices root learned during listManaged must keep it off the lease path.
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["simctl", "list", "-j", "devices"],
      ["simctl", "shutdown", driverData.udid],
      ["simctl", "erase", driverData.udid],
    ]);
    expect(await filesystem.exists(erasableMarkPath)).toBe(true);
    expect(await filesystem.exists(durableMarkPath)).toBe(true);
  });

  it("reports matching provenance tokens for a healthy managed device", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, JSON.stringify({ token: "tok-1" }));
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ token: "tok-1" }));
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({
        mark: { durable: "tok-1", erasable: "tok-1", erasableReadable: true },
      }),
    ]);
  });

  it("reports erasable undefined when the data-container mark is gone (foreign erase)", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, JSON.stringify({ token: "tok-1" }));
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({
        mark: { durable: "tok-1", erasable: undefined, erasableReadable: true },
      }),
    ]);
  });

  it("reports mark undefined when both provenance regions are absent (pre-upgrade device)", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it("reads a corrupt mark file as undefined without throwing", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dataPath);
    await filesystem.writeFileAtomic(durableMarkPath, "not json");
    await filesystem.writeFileAtomic(erasableMarkPath, JSON.stringify({ notAToken: true }));
    const runner = new ScriptedProcessRunner([
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);

    const reality = await createDriver(runner, new FakeClock(), filesystem).listManaged();

    expect(reality.devices[0]?.mark).toBeUndefined();
  });

  it.skipIf(process.env.SIMLOCK_LIVE_IOS !== "1")(
    "runs a provision-to-destroy smoke test against simctl",
    async () => {
      const driver = new IosSimctlDriver({
        clock: new SystemClock(),
        filesystem: new NodeFilesystem(),
        idGenerator: { generate: () => `test-${process.pid}` },
        processRunner: new NodeProcessRunner(),
      });
      let device: Awaited<ReturnType<IosSimctlDriver["provision"]>> | undefined;

      try {
        const liveSpec = await driver.resolveSpec(
          { model: "iPhone 17 Pro", platform: "ios" },
          { allowDownload: false },
        );
        device = await driver.provision(liveSpec);
        await driver.makeReady(device);
        await driver.reclaim(device, { clean: "standard" });
      } finally {
        if (device !== undefined) {
          await driver.destroy(device);
        }
      }
    },
    150_000,
  );
});

function createDriver(
  runner: ScriptedProcessRunner,
  clock = new FakeClock(),
  filesystem: Filesystem = new MemoryFilesystem(),
  onDiagnostic?: (diagnostic: ComponentInstallDiagnostic) => void,
): IosSimctlDriver {
  return new IosSimctlDriver({
    clock,
    filesystem,
    idGenerator: { generate: () => "device-1" },
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    processRunner: runner,
  });
}

/**
 * `#idGenerator.generate()` names the device on its first call and mints
 * mark tokens on every later call, so the first call must stay "device-1"
 * to match `driverData.name` while later calls vary to prove the reclaim
 * token differs from the provision token.
 */
function createTokenDriver(
  runner: ScriptedProcessRunner,
  filesystem: Filesystem = new MemoryFilesystem(),
): IosSimctlDriver {
  let calls = 0;
  return new IosSimctlDriver({
    clock: new FakeClock(),
    filesystem,
    idGenerator: {
      generate: () => {
        calls += 1;
        return calls === 1 ? "device-1" : `tok-${String(calls)}`;
      },
    },
    processRunner: runner,
  });
}

function scriptedListRunner(): ScriptedProcessRunner {
  return new ScriptedProcessRunner([
    {
      match: listInvocation,
      result: { code: 0, stderr: "", stdout: listFixture },
    },
  ]);
}
