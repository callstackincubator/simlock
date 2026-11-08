import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessRunner,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { driverData, instanceId } from "./test-slim.js";

const prepareFull = { mode: "full", purpose: "prepare" } as const;

describe("IosSimctlDriver DeviceHub clipboard", () => {
  it("under deviceSet default the driver turns DeviceHub's pasteboard sync off for a simulator before every boot and removes that entry when it destroys it", async () => {
    const library = "/Users/u/Library";
    const deviceHubPlist = `${library}/Containers/com.apple.dt.Devices/Data/Library/Preferences/com.apple.dt.Devices.plist`;
    const udid = driverData.udid;
    const calls: string[][] = [];
    let failCommand = "";
    let warm = false;
    let holdWrite: Promise<void> | undefined;
    let sawDelete: (() => void) | undefined;
    const warnings: string[] = [];
    const preferences: Record<string, Record<string, unknown>> = {
      [udid]: { pasteboardSyncEnabled: true, windowScale: 75 },
      other: { pasteboardSyncEnabled: true, windowScale: 50 },
    };
    const answersEveryCall: ProcessRunner = {
      run: () => Promise.reject(new Error("the driver runs commands through spawn")),
      spawn(command, args, options) {
        calls.push([command, ...args]);
        const isWarmBoot = warm && command === "xcrun" && args[1] === "boot";
        if (isWarmBoot) warm = false;
        const missingKey =
          command === "/usr/libexec/PlistBuddy" &&
          args[1]?.startsWith("Set :DevicePreferences:") &&
          preferences[udid]?.pasteboardSyncEnabled === undefined;
        const failed =
          command === failCommand ||
          (failCommand === "delete" && args[1] === "delete") ||
          isWarmBoot ||
          missingKey;
        if (!failed && command === "/usr/libexec/PlistBuddy") {
          if (args[1]?.startsWith("Set :DevicePreferences:")) {
            preferences[udid]!.pasteboardSyncEnabled = false;
          } else if (
            args[1] === `Add :DevicePreferences:${udid}:pasteboardSyncEnabled bool false`
          ) {
            preferences[udid]!.pasteboardSyncEnabled = false;
          } else if (args[1] === `Delete :DevicePreferences:${udid}`) {
            delete preferences[udid];
          }
        } else if (!failed && command === "defaults") {
          preferences[udid] = { pasteboardSyncEnabled: false };
        }
        const handle = new ScriptedProcessRunner([
          {
            match: { args: [...args], command },
            result: {
              code: failed ? 1 : 0,
              stderr: isWarmBoot ? "Unable to boot device in current state: Booted" : "failed",
              stdout: "",
            },
          },
        ]).spawn(command, args, options);
        if (command === "xcrun" && args[1] === "delete") sawDelete?.();
        if (command === "/usr/libexec/PlistBuddy" && holdWrite !== undefined) {
          const gate = holdWrite;
          holdWrite = undefined;
          const wait = handle.wait.bind(handle);
          handle.wait = async () => {
            await gate;
            return await wait();
          };
        }
        return handle;
      },
      spawnStreaming: () => {
        throw new Error("the driver streams nothing here");
      },
    };
    const driver = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      coreSimulatorRoot: `${library}/Developer/CoreSimulator`,
      driverConfig: { deviceSet: "default" },
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: answersEveryCall,
      simlockHome: "/home/.simlock",
      logger: { warn: (message: string) => warnings.push(message) } as never,
    });
    const device = { address: udid, deviceId: udid, driverData };

    const syncOffThenBoot = [
      [
        "/usr/libexec/PlistBuddy",
        "-c",
        `Set :DevicePreferences:${udid}:pasteboardSyncEnabled false`,
        deviceHubPlist,
      ],
      ["xcrun", "simctl", "boot", udid],
      ["xcrun", "simctl", "bootstatus", udid, "-b"],
      ["xcrun", "simctl", "listapps", udid],
    ];

    await driver.makeReady(device, prepareFull);
    expect(preferences).toEqual({
      [udid]: { pasteboardSyncEnabled: false, windowScale: 75 },
      other: { pasteboardSyncEnabled: true, windowScale: 50 },
    });
    await driver.makeReady(device, { mode: "full", purpose: "recover" });
    await driver.destroy(device);
    expect(preferences).toEqual({ other: { pasteboardSyncEnabled: true, windowScale: 50 } });

    expect(calls).toEqual([
      ...syncOffThenBoot,
      ...syncOffThenBoot,
      ["xcrun", "simctl", "shutdown", udid],
      ["xcrun", "simctl", "delete", udid],
      ["/usr/libexec/PlistBuddy", "-c", `Delete :DevicePreferences:${udid}`, deviceHubPlist],
    ]);

    preferences[udid] = { windowScale: 75 };
    calls.length = 0;
    await expect(driver.makeReady(device, prepareFull)).resolves.toBeDefined();
    expect(preferences[udid]).toEqual({ pasteboardSyncEnabled: false, windowScale: 75 });
    expect(calls).toContainEqual([
      "/usr/libexec/PlistBuddy",
      "-c",
      `Add :DevicePreferences:${udid}:pasteboardSyncEnabled bool false`,
      deviceHubPlist,
    ]);

    let releaseWrite!: () => void;
    holdWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const deleted = new Promise<void>((resolve) => {
      sawDelete = resolve;
    });
    calls.length = 0;
    const preparing = driver.makeReady(device, prepareFull);
    await vi.waitFor(() =>
      expect(calls.some((call) => call[0] === "/usr/libexec/PlistBuddy")).toBe(true),
    );
    const destroying = driver.destroy(device);
    await deleted;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls.some((call) => call[2] === `Delete :DevicePreferences:${udid}`)).toBe(false);
    releaseWrite();
    await Promise.all([preparing, destroying]);
    expect(preferences[udid]).toBeUndefined();
    sawDelete = undefined;

    preferences[udid] = { pasteboardSyncEnabled: true, windowScale: 75 };
    calls.length = 0;
    failCommand = "/usr/libexec/PlistBuddy";
    await expect(driver.makeReady(device, prepareFull)).rejects.toThrow(
      "Could not disable DeviceHub clipboard sync",
    );
    expect(calls.every((call) => call[0] === "/usr/libexec/PlistBuddy")).toBe(true);

    calls.length = 0;
    failCommand = "";
    warm = true;
    await driver.makeReady(device, prepareFull);
    expect(calls.slice(0, 4)).toEqual([
      syncOffThenBoot[0],
      ["xcrun", "simctl", "boot", udid],
      ["xcrun", "simctl", "shutdown", udid],
      ["xcrun", "simctl", "boot", udid],
    ]);

    calls.length = 0;
    failCommand = "/usr/libexec/PlistBuddy";
    await expect(driver.destroy(device)).resolves.toBeUndefined();
    expect(warnings).toContain(
      `could not remove DeviceHub preference for ${udid}: preference deletion failed`,
    );

    calls.length = 0;
    failCommand = "delete";
    await expect(driver.destroy(device)).rejects.toThrow();
    expect(calls.some((call) => call[0] === "/usr/libexec/PlistBuddy")).toBe(false);
  });
});
