import { describe, expect, it, vi } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";

const coreSimulatorRoot = "/Users/test/Library/Developer/CoreSimulator";
const preferencesPath =
  "/Users/test/Library/Containers/com.apple.dt.Devices/Data/Library/Preferences/com.apple.dt.Devices.plist";
const udids = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
] as const;

describe("IosSimctlDriver DeviceHub preferences", () => {
  it("requests pasteboard sync disabled before boot for full-mode preparation and recovery", async () => {
    const database = await memorySourceDatabase();
    try {
      for (const [index, udid] of udids.entries()) {
        const preferences = new ScriptedProcessRunner([
          {
            match: {
              command: "defaults",
              args: ["write", preferencesPath, "DevicePreferences", "-dict-add", udid, /.*/],
            },
          },
        ]);
        let writesAtBoot: readonly unknown[] = [];
        const runner = new ScriptedProcessRunner([
          {
            match: { command: "xcrun", args: ["simctl", "boot", udid] },
            onSpawn: () => {
              writesAtBoot = preferences.calls.map(({ command, args }) => ({ command, args }));
            },
          },
          { match: { command: "xcrun", args: ["simctl", "bootstatus", udid, "-b"] } },
          { match: { command: "xcrun", args: ["simctl", "listapps", udid] } },
        ]);
        const spawn = runner.spawn.bind(runner);
        vi.spyOn(runner, "spawn").mockImplementation((command, args, options) =>
          command === "defaults"
            ? preferences.spawn(command, args, options)
            : spawn(command, args, options),
        );
        const driver = await IosSimctlDriver.create({
          clock: new FakeClock(),
          coreSimulatorRoot,
          database,
          driverConfig: { deviceSet: "default" },
          filesystem: new MemoryFilesystem(),
          idGenerator: { generate: () => "test-id" },
          instanceId: "test-instance",
          processRunner: runner,
          simlockHome: "/Users/test/.simlock",
        });

        await driver.makeReady(
          {
            address: udid,
            deviceId: udid,
            driverData: {
              deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
              name: `simlock-${index}`,
              runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
              udid,
            },
          },
          { mode: "full", purpose: index === 0 ? "prepare" : "recover" },
        );

        expect.soft(writesAtBoot, `${udid}: DeviceHub preference write before boot`).toEqual([
          {
            command: "defaults",
            args: [
              "write",
              preferencesPath,
              "DevicePreferences",
              "-dict-add",
              udid,
              "<dict><key>pasteboardSyncEnabled</key><false/></dict>",
            ],
          },
        ]);
      }
    } finally {
      database.close();
      vi.restoreAllMocks();
    }
  });
});
