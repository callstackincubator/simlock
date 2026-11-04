import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { AdbTools } from "./adb-tools.js";
import { AvdConfig } from "./avd-config.js";
import { DeviceTable } from "./device-table.js";
import { Ownership } from "./ownership.js";
import { ANDROID_HOME_DIRECTORY, ANDROID_SDK_ROOT } from "./testing.js";

const adb = `${ANDROID_SDK_ROOT}/platform-tools/adb`;
const deviceRoot = "/simlock/devices/android";

function createTable(): DeviceTable {
  const filesystem = new MemoryFilesystem();
  const adbTools = new AdbTools({
    adb,
    adbServerPort: 5038,
    baseEnv: { ANDROID_HOME: ANDROID_SDK_ROOT },
    clock: new FakeClock(),
    deviceRoot,
    emulator: `${ANDROID_SDK_ROOT}/emulator/emulator`,
    processRunner: new ScriptedProcessRunner([]),
  });
  return new DeviceTable({
    adbTools,
    avdConfig: new AvdConfig({
      adb,
      adbTools,
      filesystem,
      idGenerator: { generate: () => "1" },
      seedLaunchInputs: [],
    }),
    avdmanager: `${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager`,
    baseEnv: { ANDROID_HOME: ANDROID_SDK_ROOT },
    deviceRoot,
    filesystem,
    legacyAvdHome: `${ANDROID_HOME_DIRECTORY}/.android/avd`,
    ownership: new Ownership({ adb, adbTools, filesystem }),
    register: async () => undefined,
  });
}

// why: a part of a decomposed module (ADR 0063 §2): these tests build `DeviceTable` directly and prove what it alone makes.
describe("DeviceTable", () => {
  it("starts a second call under one device's lock only after the first ends, and a call on another device does not wait", async () => {
    const table = createTable();
    const events: string[] = [];
    let endFirst!: () => void;
    const firstMayEnd = new Promise<void>((resolve) => {
      endFirst = resolve;
    });

    const first = table.withLock("device-a", async () => {
      events.push("first starts");
      await firstMayEnd;
      events.push("first ends");
    });
    const second = table.withLock("device-a", async () => {
      events.push("second starts");
    });
    const other = table.withLock("device-b", async () => {
      events.push("other starts");
    });
    await other;
    await Promise.resolve();
    const beforeFirstEnds = [...events];
    endFirst();
    await Promise.all([first, second]);

    expect(beforeFirstEnds).toEqual(["first starts", "other starts"]);
    expect(events).toEqual(["first starts", "other starts", "first ends", "second starts"]);
  });
});
