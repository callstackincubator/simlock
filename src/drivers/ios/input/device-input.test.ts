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

function simulator(runtimeId?: string): VirtualDriverDevice {
  return {
    address: "UDID-1",
    deviceId: "UDID-1",
    driverData: {
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      name: "simlock-1",
      runtimeId: runtimeId ?? "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      udid: "UDID-1",
    },
    physical: false,
  };
}

function setup(inOwnSet = true) {
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
    baseEnvironment: { PATH: "/usr/bin", SIMLOCK_IOS_DEVICE_SET: "/daemon/own-set" },
    clock,
    command: COMMAND,
    ...(inOwnSet ? { deviceSet: DEVICE_SET } : {}),
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

    const inXcodeSet = setup(false);
    const xcodeOpen = inXcodeSet.factory.open(simulator(), new AbortController().signal);
    expect(inXcodeSet.launcher.starts.map((start) => start.env)).toEqual([{ PATH: "/usr/bin" }]);
    inXcodeSet.launcher.last.write(envelope(INPUT_TAG.config, { height: 2556, width: 1179 }));
    await xcodeOpen;

    for (const runtimeId of [
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      "com.apple.CoreSimulator.SimRuntime.iOS-28-1",
      "garbage",
    ]) {
      const other = setup();
      const opened = other.factory.open(simulator(runtimeId), new AbortController().signal);
      other.launcher.last.write(envelope(INPUT_TAG.config, { height: 2556, width: 1179 }));
      const limited = (await opened) as DeviceInput;
      const limitedConfigs: InputScreenConfig[] = [];
      limited.onConfig((config) => limitedConfigs.push(config));
      expect(limitedConfigs).toEqual([
        { height: 2556, keyboardUnavailable: true, orientation: "portrait", width: 1179 },
      ]);
      limited.send({ kind: "key", type: "down", usage: 0x04 });
      limited.send({ kind: "touch", type: "begin", x: 0.5, y: 0.25 });
      expect(decoded(other.launcher.last.stdinWrites)).toEqual([
        { body: { type: "begin", x: 0.5, y: 0.25 }, tag: INPUT_TAG.touch },
      ]);
    }
  });

  it("an open rejects when the helper is missing, exits first or reports no size within 10 s, and a helper that exits later fails the input", async () => {
    const missing = setup();
    const missingOpen = missing.factory.open(simulator(), new AbortController().signal);
    missing.launcher.last.exit({ code: null, error: "spawn ENOENT", signal: null });
    await expect(missingOpen).rejects.toThrow(
      "The input helper could not be started: spawn ENOENT",
    );

    const early = setup();
    const earlyOpen = early.factory.open(simulator(), new AbortController().signal);
    early.launcher.last.exit({ code: 1, signal: null });
    await expect(earlyOpen).rejects.toThrow(
      "The input helper exited with code 1 before it reported the screen size",
    );

    const silent = setup();
    const silentOpen = silent.factory.open(simulator(), new AbortController().signal).then(
      () => "opened",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    let settled = false;
    void silentOpen.then(() => {
      settled = true;
    });
    silent.clock.advance(9_900);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    silent.clock.advance(100);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(await silentOpen).toBe("The input helper reported no screen size within 10 s");
    expect(silent.launcher.last.stdinClosed).toBe(true);

    const later = setup();
    const laterOpen = later.factory.open(simulator(), new AbortController().signal);
    later.launcher.last.write(envelope(INPUT_TAG.config, { height: 2556, width: 1179 }));
    const input = (await laterOpen) as DeviceInput;
    const failures: string[] = [];
    input.onFailed((error) => failures.push(error.message));
    later.launcher.last.exit({ code: 1, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toEqual(["The input helper exited with code 1"]);
  });

  it("closing stops the helper without failing the input, and a failed write fails the input and stops the helper", async () => {
    const closing = setup();
    const closingOpen = closing.factory.open(simulator(), new AbortController().signal);
    closing.launcher.last.write(envelope(INPUT_TAG.config, { height: 2556, width: 1179 }));
    const closable = (await closingOpen) as DeviceInput;
    const closeFailures: string[] = [];
    closable.onFailed((error) => closeFailures.push(error.message));
    await closable.close();
    expect(closing.launcher.last.stdinClosed).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeFailures).toEqual([]);

    const broken = setup();
    const brokenOpen = broken.factory.open(simulator(), new AbortController().signal);
    broken.launcher.last.write(envelope(INPUT_TAG.config, { height: 2556, width: 1179 }));
    const input = (await brokenOpen) as DeviceInput;
    const failures: string[] = [];
    input.onFailed((error) => failures.push(error.message));
    broken.launcher.last.writeError = new Error("write EPIPE");
    input.send({ kind: "touch", type: "begin", x: 0.5, y: 0.5 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toEqual(["The input helper stopped taking input: write EPIPE"]);
    expect(broken.launcher.last.stdinClosed).toBe(true);
  });

  it("a physical iPhone's device input is unavailable and no process is started", async () => {
    const { clock, factory, launcher } = setup();
    const pending = factory
      .open(
        {
          address: "UDID-1",
          deviceId: "UDID-1",
          driverData: {},
          enrolledApps: [],
          physical: true,
        },
        new AbortController().signal,
      )
      .catch((error: unknown) => (error instanceof Error ? error.message : "not an error"));
    clock.advance(10_000);
    const opening = await pending;
    expect(opening).toEqual({ unavailable: "Input is not supported on physical iPhones" });
    expect(launcher.starts).toEqual([]);
  });
});
