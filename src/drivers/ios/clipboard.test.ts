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

type Preferences = Record<string, Record<string, unknown>>;

/**
 * why: DeviceHub's preferences live in cfprefsd, so the driver may only change them by
 * exporting the domain, editing the export and importing it back; this fake keeps the domain
 * and the export apart so an edit that skips the import changes nothing.
 */
class FakeDeviceHubDomain {
  domain: Preferences = {};
  staged: Preferences = {};
  failing = "";
  hold: Promise<void> | undefined;

  succeeds(command: string, args: readonly string[]): boolean {
    if (command === this.failing || (this.failing === "delete" && args[1] === "delete")) {
      return false;
    }
    if (command === "defaults") this.transfer(args[0]!);
    return command === "/usr/libexec/PlistBuddy" ? this.edit(args[1]!) : true;
  }

  private transfer(verb: string): void {
    if (verb === "export") this.staged = structuredClone(this.domain);
    if (verb === "import") this.domain = structuredClone(this.staged);
  }

  private edit(command: string): boolean {
    const [verb, path = "", value] = command.split(" ");
    const [, , udid, key] = path.split(":");
    const entry = udid === undefined ? undefined : this.staged[udid];
    if (verb === "Delete" && entry !== undefined) {
      delete this.staged[udid!];
      return true;
    }
    if (verb === "Set" && entry?.[key!] !== undefined) {
      entry[key!] = value === "true";
      return true;
    }
    if (verb === "Add" && key === undefined && udid !== undefined && entry === undefined) {
      this.staged[udid] = {};
      return true;
    }
    if (verb === "Add" && entry !== undefined && key !== undefined) {
      entry[key] = false;
      return true;
    }
    return false;
  }
}

describe("IosSimctlDriver DeviceHub clipboard", () => {
  it("under deviceSet default the driver turns DeviceHub's pasteboard sync off for a simulator before every boot and removes that entry when it destroys it", async () => {
    const udid = driverData.udid;
    const calls: string[][] = [];
    const hub = new FakeDeviceHubDomain();
    hub.domain = {
      [udid]: { pasteboardSyncEnabled: true, windowScale: 75 },
      other: { pasteboardSyncEnabled: true, windowScale: 50 },
    };
    let warm = false;
    let sawDelete: (() => void) | undefined;
    const warnings: string[] = [];
    const answersEveryCall: ProcessRunner = {
      run: () => Promise.reject(new Error("the driver runs commands through spawn")),
      spawn(command, args, options) {
        calls.push([command, ...args]);
        const isWarmBoot = warm && command === "xcrun" && args[1] === "boot";
        if (isWarmBoot) warm = false;
        const failed = !hub.succeeds(command, args) || isWarmBoot;
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
        if (command === "defaults" && args[0] === "import" && hub.hold !== undefined) {
          const gate = hub.hold;
          hub.hold = undefined;
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
      coreSimulatorRoot: "/Users/u/Library/Developer/CoreSimulator",
      driverConfig: { deviceSet: "default" },
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: answersEveryCall,
      simlockHome: "/home/.simlock",
      logger: { warn: (message: string) => warnings.push(message) } as never,
    });
    const device = { address: udid, deviceId: udid, driverData };
    const staged = (command: string) => [
      "/usr/libexec/PlistBuddy",
      "-c",
      command,
      expect.any(String),
    ];
    const exportDomain = ["defaults", "export", "com.apple.dt.Devices", expect.any(String)];
    const importDomain = ["defaults", "import", "com.apple.dt.Devices", expect.any(String)];

    const syncOffThenBoot = [
      exportDomain,
      staged(`Set :DevicePreferences:${udid}:pasteboardSyncEnabled false`),
      importDomain,
      ["xcrun", "simctl", "boot", udid],
      ["xcrun", "simctl", "bootstatus", udid, "-b"],
      ["xcrun", "simctl", "listapps", udid],
    ];

    await driver.makeReady(device, prepareFull);
    expect(hub.domain).toEqual({
      [udid]: { pasteboardSyncEnabled: false, windowScale: 75 },
      other: { pasteboardSyncEnabled: true, windowScale: 50 },
    });
    await driver.makeReady(device, { mode: "full", purpose: "recover" });
    await driver.destroy(device);
    expect(hub.domain).toEqual({ other: { pasteboardSyncEnabled: true, windowScale: 50 } });

    expect(calls).toEqual([
      ...syncOffThenBoot,
      ...syncOffThenBoot,
      ["xcrun", "simctl", "shutdown", udid],
      ["xcrun", "simctl", "delete", udid],
      exportDomain,
      staged(`Delete :DevicePreferences:${udid}`),
      importDomain,
    ]);

    hub.domain = { [udid]: { windowScale: 75 } };
    calls.length = 0;
    await expect(driver.makeReady(device, prepareFull)).resolves.toBeDefined();
    expect(hub.domain[udid]).toEqual({ pasteboardSyncEnabled: false, windowScale: 75 });
    expect(calls).toContainEqual(
      staged(`Add :DevicePreferences:${udid}:pasteboardSyncEnabled bool false`),
    );

    let releaseWrite!: () => void;
    hub.hold = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const deleted = new Promise<void>((resolve) => {
      sawDelete = resolve;
    });
    calls.length = 0;
    const preparing = driver.makeReady(device, prepareFull);
    await vi.waitFor(() => expect(calls.some((call) => call[1] === "import")).toBe(true));
    const destroying = driver.destroy(device);
    await deleted;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls.some((call) => call[2] === `Delete :DevicePreferences:${udid}`)).toBe(false);
    releaseWrite();
    await Promise.all([preparing, destroying]);
    expect(hub.domain[udid]).toBeUndefined();
    sawDelete = undefined;

    hub.domain = { [udid]: { pasteboardSyncEnabled: true, windowScale: 75 } };
    calls.length = 0;
    hub.failing = "defaults";
    await expect(driver.makeReady(device, prepareFull)).rejects.toThrow(
      "Could not disable DeviceHub clipboard sync",
    );
    expect(calls.every((call) => call[0] === "defaults")).toBe(true);
    expect(hub.domain[udid]?.pasteboardSyncEnabled).toBe(true);

    calls.length = 0;
    hub.failing = "";
    warm = true;
    await driver.makeReady(device, prepareFull);
    expect(calls.slice(0, 6)).toEqual([
      ...syncOffThenBoot.slice(0, 4),
      ["xcrun", "simctl", "shutdown", udid],
      ["xcrun", "simctl", "boot", udid],
    ]);

    calls.length = 0;
    hub.failing = "defaults";
    await expect(driver.destroy(device)).resolves.toBeUndefined();
    expect(warnings).toContain(
      `could not remove DeviceHub preference for ${udid}: preference deletion failed`,
    );

    calls.length = 0;
    hub.failing = "delete";
    await expect(driver.destroy(device)).rejects.toThrow();
    expect(calls.some((call) => call[0] === "defaults")).toBe(false);
  });
});
