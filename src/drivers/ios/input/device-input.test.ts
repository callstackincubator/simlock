import { describe, expect, it } from "vitest";

import {
  encodeScreenFrame,
  INPUT_TAG,
  isUnavailableInput,
  type DeviceInput,
  type InputScreenConfig,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import { FakeBytePipeLauncher, FakeClock, ScriptedProcessRunner } from "../../../ports/index.js";
import { createIosDeviceInput } from "./index.js";

const COMMAND = "/opt/simlock/simlock-screen-capture";
const DEVICE_SET = "/home/.simlock/devices/ios";

function simulator(runtimeId = "com.apple.CoreSimulator.SimRuntime.iOS-26-5"): VirtualDriverDevice {
  return {
    address: "UDID-1",
    deviceId: "UDID-1",
    driverData: {
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      name: "simlock-1",
      runtimeId,
      udid: "UDID-1",
    },
    physical: false,
  };
}

function setup() {
  const launcher = new FakeBytePipeLauncher();
  const clock = new FakeClock();
  const processRunner = new ScriptedProcessRunner([
    {
      match: {
        args: ["simctl", "--set", DEVICE_SET, "launch", "UDID-1", "com.apple.springboard"],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: "" },
    },
  ]);
  const factory = createIosDeviceInput({
    baseEnvironment: { PATH: "/usr/bin" },
    clock,
    command: COMMAND,
    deviceSet: DEVICE_SET,
    launcher,
    processRunner,
  });
  return { clock, factory, launcher, processRunner };
}

function envelope(tag: number, body: unknown): Uint8Array {
  return encodeScreenFrame(tag, new TextEncoder().encode(JSON.stringify(body)));
}

function decoded(writes: readonly Uint8Array[]): { tag: number; body: unknown }[] {
  return writes.map((bytes) => ({
    body: JSON.parse(new TextDecoder().decode(bytes.subarray(5))) as unknown,
    tag: bytes[4] ?? -1,
  }));
}

describe("iOS device input", () => {
  it("touches, buttons, scrolls and keys on an iOS simulator reach the HID helper", async () => {
    const { factory, launcher, processRunner } = setup();
    const opening = factory.open(simulator(), new AbortController().signal);
    expect(launcher.starts).toEqual([
      {
        args: ["UDID-1", "--input"],
        command: COMMAND,
        env: { PATH: "/usr/bin", SIMLOCK_IOS_DEVICE_SET: DEVICE_SET },
      },
    ]);
    launcher.last.write(envelope(INPUT_TAG.config, { height: 2556, width: 1179 }));
    const input = (await opening) as DeviceInput;
    const configs: InputScreenConfig[] = [];
    input.onConfig((config) => configs.push(config));
    expect(configs).toEqual([{ height: 2556, orientation: "portrait", width: 1179 }]);

    input.send({ kind: "touch", type: "begin", x: 0.5, y: 0.25 });
    input.send({ kind: "touch", type: "move", x: 0.5, y: 0.5 });
    input.send({ kind: "touch", type: "end", x: 0.5, y: 0.5 });
    expect(decoded(launcher.last.stdinWrites)).toEqual([
      { body: { type: "begin", x: 0.5, y: 0.25 }, tag: INPUT_TAG.touch },
      { body: { type: "move", x: 0.5, y: 0.5 }, tag: INPUT_TAG.touch },
      { body: { type: "end", x: 0.5, y: 0.5 }, tag: INPUT_TAG.touch },
    ]);
    const writtenBefore = launcher.last.stdinWrites.length;

    input.send({ button: "app_switcher", kind: "button" });
    input.send({ button: "lock", kind: "button" });
    input.send({ button: "back", kind: "button" });
    expect(processRunner.calls).toEqual([]);
    expect(launcher.last.stdinWrites).toHaveLength(writtenBefore);
    input.send({ button: "home", kind: "button" });
    expect(processRunner.calls).toEqual([
      {
        args: ["simctl", "--set", DEVICE_SET, "launch", "UDID-1", "com.apple.springboard"],
        command: "xcrun",
        options: { timeoutMs: 10_000 },
      },
    ]);
    expect(launcher.last.stdinWrites).toHaveLength(writtenBefore);

    input.send({ dx: 0, dy: 0.5, kind: "scroll", x: 0.5, y: 0.25 });
    input.send({ dx: -0.25, dy: 0, kind: "scroll" });
    input.send({ kind: "key", type: "down", usage: 0x04 });
    input.send({ kind: "key", type: "up", usage: 0x04 });
    expect(decoded(launcher.last.stdinWrites.slice(writtenBefore))).toEqual([
      { body: { dx: 0, dy: 0.5, x: 0.5, y: 0.25 }, tag: INPUT_TAG.scroll },
      { body: { dx: -0.25, dy: 0 }, tag: INPUT_TAG.scroll },
      { body: { type: "down", usage: 0x04 }, tag: INPUT_TAG.key },
      { body: { type: "up", usage: 0x04 }, tag: INPUT_TAG.key },
    ]);
    expect(isUnavailableInput(input)).toBe(false);
  });
});
