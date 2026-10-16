import { describe, expect, it } from "vitest";

import { ScreenUnavailableError } from "../../core/index.js";
import { FakeBytePipeLauncher, FakeClock, MemoryFilesystem } from "../../ports/index.js";
import { createIosScreenCapture } from "./screen-capture.js";

const settings = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };
const simulator = {
  address: "UDID-1",
  deviceId: "UDID-1",
  driverData: {},
  physical: false,
} as const;
const physical = {
  address: "UDID-1",
  deviceId: "UDID-1",
  driverData: {},
  enrolledApps: [],
  physical: true,
} as const;
const COMMAND = "/opt/simlock/simlock-screen-capture";
const DEVICE_COMMAND = "/opt/simlock/simlock-device-capture";

async function setup(options: { deviceCommand?: string } = {}) {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/opt/simlock");
  await filesystem.writeFileAtomic(COMMAND, "");
  await filesystem.writeFileAtomic(DEVICE_COMMAND, "");
  const launcher = new FakeBytePipeLauncher();
  const clock = new FakeClock();
  const capture = createIosScreenCapture({
    baseEnvironment: { PATH: "/usr/bin" },
    clock,
    command: COMMAND,
    ...(options.deviceCommand === undefined ? {} : { deviceCommand: options.deviceCommand }),
    deviceSet: "/home/.simlock/devices/ios",
    filesystem,
    launcher,
  });
  return { capture, clock, filesystem, launcher };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const bytes: number[] = [];
  for await (const chunk of stream) bytes.push(...chunk);
  return bytes;
}

describe("iOS screen capture", () => {
  it("an open whose signal was already stopped starts nothing", async () => {
    const { capture, launcher } = await setup();
    const stopped = new AbortController();
    stopped.abort();
    await expect(capture.open(simulator, settings, stopped.signal)).rejects.toBeInstanceOf(
      ScreenUnavailableError,
    );
    expect(launcher.starts).toEqual([]);
  });

  it("runs the capture program on the device's UDID, inside Simlock's device set, with the stream's settings, and never the device program", async () => {
    const { capture, launcher } = await setup({ deviceCommand: DEVICE_COMMAND });
    await capture.open(simulator, settings, new AbortController().signal);
    expect(launcher.starts).toEqual([
      {
        args: [
          "UDID-1",
          "--codec",
          "avcc",
          "--fps",
          "30",
          "--bitrate",
          "1500000",
          "--max-dimension",
          "720",
        ],
        command: COMMAND,
        env: { PATH: "/usr/bin", SIMLOCK_IOS_DEVICE_SET: "/home/.simlock/devices/ios" },
      },
    ]);
  });

  it("a physical iPhone starts the device program on its UDID with the stream's settings and without Simlock's device set", async () => {
    const { capture, launcher } = await setup({ deviceCommand: DEVICE_COMMAND });
    await capture.open(physical, settings, new AbortController().signal);
    expect(launcher.starts).toEqual([
      {
        args: [
          "UDID-1",
          "--codec",
          "avcc",
          "--fps",
          "30",
          "--bitrate",
          "1500000",
          "--max-dimension",
          "720",
        ],
        command: DEVICE_COMMAND,
        env: { PATH: "/usr/bin" },
      },
    ]);
  });

  it("refuses a physical open with the build's own reason when the device program is missing, starts nothing, and a simulator open still works", async () => {
    const { capture, filesystem, launcher } = await setup({ deviceCommand: DEVICE_COMMAND });
    await filesystem.rm(DEVICE_COMMAND);
    await expect(
      capture.open(physical, settings, new AbortController().signal),
    ).rejects.toBeInstanceOf(ScreenUnavailableError);
    await expect(capture.open(physical, settings, new AbortController().signal)).rejects.toThrow(
      `Physical iPhone streams need simlock-device-capture, which did not build on this Mac (it needs Xcode 27, CoreDevice 642.x); there is none at ${DEVICE_COMMAND}`,
    );
    expect(launcher.starts).toEqual([]);
    await expect(
      capture.open(simulator, settings, new AbortController().signal),
    ).resolves.toBeDefined();
  });

  it("starts either program without SIMLOCK_COREDEVICE_INFO_PLIST, even when the daemon's environment has it", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/opt/simlock");
    await filesystem.writeFileAtomic(COMMAND, "");
    await filesystem.writeFileAtomic(DEVICE_COMMAND, "");
    const launcher = new FakeBytePipeLauncher();
    const capture = createIosScreenCapture({
      baseEnvironment: {
        PATH: "/usr/bin",
        SIMLOCK_COREDEVICE_INFO_PLIST: "/tmp/another-coredevice.plist",
      },
      clock: new FakeClock(),
      command: COMMAND,
      deviceCommand: DEVICE_COMMAND,
      deviceSet: "/home/.simlock/devices/ios",
      filesystem,
      launcher,
    });
    await capture.open(simulator, settings, new AbortController().signal);
    await capture.open(physical, settings, new AbortController().signal);
    expect(launcher.starts.map((start) => start.env)).toEqual([
      { PATH: "/usr/bin", SIMLOCK_IOS_DEVICE_SET: "/home/.simlock/devices/ios" },
      { PATH: "/usr/bin" },
    ]);
  });

  it("reports streaming available when only the device program is missing, and the simulator program's reason when that one is", async () => {
    const { capture, filesystem } = await setup({ deviceCommand: DEVICE_COMMAND });
    await filesystem.rm(DEVICE_COMMAND);
    expect(await capture.unavailable()).toBeUndefined();

    await filesystem.writeFileAtomic(DEVICE_COMMAND, "");
    await filesystem.rm(COMMAND);
    expect(await capture.unavailable()).toBe(`No screen capture program at ${COMMAND}`);
  });

  it("refuses as unavailable, and says why, when the capture program is not installed", async () => {
    const { capture, filesystem, launcher } = await setup();
    await filesystem.rm(COMMAND);
    expect(await capture.unavailable()).toBe(`No screen capture program at ${COMMAND}`);
    await expect(
      capture.open(simulator, settings, new AbortController().signal),
    ).rejects.toBeInstanceOf(ScreenUnavailableError);
    expect(launcher.starts).toEqual([]);
  });

  it("hands out the program's stdout byte for byte and ends cleanly when it exits 0", async () => {
    const { capture, launcher } = await setup();
    const feed = await capture.open(simulator, settings, new AbortController().signal);
    launcher.last.write(new Uint8Array([1, 2, 3]));
    launcher.last.exit({ code: 0, signal: null });
    expect(await readAll(feed.body)).toEqual([1, 2, 3]);
  });

  it("fails the body with the program's last log line when it dies mid-picture", async () => {
    const { capture, launcher } = await setup();
    const feed = await capture.open(simulator, settings, new AbortController().signal);
    launcher.last.stderr("Device UDID-1 shut down");
    launcher.last.exit({ code: 3, signal: null });
    await expect(readAll(feed.body)).rejects.toThrow(
      "The screen capture program exited with code 3: Device UDID-1 shut down",
    );
  });

  it("close stops the program through stdin and resolves once it has exited", async () => {
    const { capture, launcher } = await setup();
    const feed = await capture.open(simulator, settings, new AbortController().signal);
    launcher.last.exitOnStdinClose = false;
    let closed = false;
    const closing = feed.close().then(() => (closed = true));
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(launcher.last.stdinClosed).toBe(true);
    expect(closed).toBe(false);
    launcher.last.exit({ code: 0, signal: null });
    await closing;
    expect(launcher.last.kills).toEqual([]);
  });

  it("close kills a program that ignores its closed stdin once the grace runs out", async () => {
    const { capture, clock, launcher } = await setup();
    const feed = await capture.open(simulator, settings, new AbortController().signal);
    launcher.last.exitOnStdinClose = false;
    const closed = feed.close();
    await Promise.resolve();
    clock.advance(1_999);
    await Promise.resolve();
    expect(launcher.last.kills).toEqual([]);
    clock.advance(1);
    await closed;
    expect(launcher.last.kills).toEqual(["SIGKILL"]);
  });

  it("cancelling the body stops the program, and a second close does not stop it again", async () => {
    const { capture, launcher } = await setup();
    const feed = await capture.open(simulator, settings, new AbortController().signal);
    await feed.body.cancel();
    await feed.close();
    expect(launcher.last.stdinCloses).toBe(1);
    expect(launcher.last.kills).toEqual([]);
    expect(launcher.processes).toHaveLength(1);
  });
});
