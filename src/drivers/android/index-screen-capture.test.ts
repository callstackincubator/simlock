import { describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from "../../ports/index.js";
import {
  androidFilesystem,
  binaries,
  EmulatorExitingRunner,
  adbServerPort,
  scopedEnv,
  createDriver,
  emptyLines,
} from "./testing.js";
import { sdk } from "./test-index.js";

describe("AndroidDriver screen capture", () => {
  const serverPath = "/simlock/vendor/scrcpy-server-v5.0.1";
  const running = {
    address: "emulator-5586",
    deviceId: "simlock_one",
    driverData: { avdName: "simlock_one", configHash: "h", port: 5586, serial: "emulator-5586" },
    physical: false,
  } as const;
  const settings = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };

  it("is offered, with the device input, only when both the server path and a TCP stream connector are given", async () => {
    const both = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    expect(both.screenCapture).toBeDefined();
    expect(both.input).toBeDefined();
    const noPath = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    expect(noPath.screenCapture).toBeUndefined();
    expect(noPath.input).toBeUndefined();
    const noConnector = await createDriver(
      await androidFilesystem(),
      new EmulatorExitingRunner([]),
      {
        scrcpyServerPath: serverPath,
      },
    );
    expect(noConnector.screenCapture).toBeUndefined();
    expect(noConnector.input).toBeUndefined();
  });

  it("pushes the server with this driver's adb, its scoped environment and the device's serial", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const runner = new EmulatorExitingRunner([
      {
        match: {
          args: ["-s", "emulator-5586", "push", serverPath, /simlock-scrcpy-/],
          command: binaries.adb,
        },
        result: { code: 1, stderr: "error: closed", stdout: "" },
      },
      {
        match: {
          args: ["-s", "emulator-5586", "shell", "rm", "-f", /simlock-scrcpy-/],
          command: binaries.adb,
        },
      },
    ]);
    const driver = await createDriver(filesystem, runner, {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    await expect(
      driver.screenCapture?.open(running, settings, new AbortController().signal),
    ).rejects.toThrow(/error: closed/);
    expect(runner.calls[0]?.options.env).toEqual(scopedEnv);
    expect(runner.calls[1]?.options.env).toEqual(scopedEnv);
  });

  it("refuses an emulator that is not running, before running anything", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const runner = new EmulatorExitingRunner([]);
    const driver = await createDriver(filesystem, runner, {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    const stopped = { ...running, driverData: { ...running.driverData, port: 0, serial: "" } };
    await expect(
      driver.screenCapture?.open(stopped, settings, new AbortController().signal),
    ).rejects.toThrow(/not running/);
    expect(runner.calls).toEqual([]);
  });

  it("routes each device's capture to its own adb server: a phone's commands run adb -P 5037 and its socket connects to 5037, an emulator's use Simlock's port", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const phone = {
      address: "R58M123ABC",
      deviceId: "R58M123ABC",
      driverData: {},
      enrolledApps: [],
      physical: true,
    } as const;
    const clock = new FakeClock(1_000);
    // why: the shared server answers the version check with Simlock's own protocol, so the phone's
    // target is open and its commands are expected to go out.
    const probe = new FakeTcpProbe([5038, 5037]);
    probe.replyWith("OKAY00040029");
    const runner = new CaptureRoutingRunner();
    const tcp = new FakeTcpStreamConnector();
    const driver = await createDriver(filesystem, runner, {
      clock,
      scrcpyServerPath: serverPath,
      tcpProbe: probe,
      tcpStreamConnector: tcp,
    });

    // why: each open is stopped while it waits on its socket's first reply — which is exactly the
    // moment this test owns: every command has gone out through the device's own server, the socket
    // has been aimed at the device, and a stop runs nothing further.
    const phoneStop = new AbortController();
    const phoneOpening = driver.screenCapture?.open(phone, settings, phoneStop.signal);
    if (phoneOpening === undefined) throw new Error("the driver offers no screen capture");
    // why: the rejection is asserted below; marking it handled here keeps a rejection that arrives
    // while this test is still reading the socket from being reported as unhandled.
    phoneOpening.catch(() => undefined);
    await waitForSocket(clock, tcp, 1);
    expect(tcp.connections[0]?.port).toBe(5037);
    expect(tcp.connections[0]?.peer.writtenText()).toContain("host:transport:R58M123ABC");
    phoneStop.abort();
    await expect(driveOpen(clock, phoneOpening)).rejects.toThrow(/closed the connection/);

    const emulatorStop = new AbortController();
    const emulatorOpening = driver.screenCapture?.open(running, settings, emulatorStop.signal);
    if (emulatorOpening === undefined) throw new Error("the driver offers no screen capture");
    emulatorOpening.catch(() => undefined);
    await waitForSocket(clock, tcp, 2);
    expect(tcp.connections[1]?.port).toBe(adbServerPort);
    expect(tcp.connections[1]?.peer.writtenText()).toContain("host:transport:emulator-5586");
    emulatorStop.abort();
    await expect(driveOpen(clock, emulatorOpening)).rejects.toThrow(/closed the connection/);

    // why: every command the phone's session ran aims at the shared server — `adb -P 5037` with
    // that server's env, Simlock's port in it and the three keys that could aim adb elsewhere
    // removed — and every command the emulator's session ran carries this driver's scoped env,
    // which points at Simlock's own port. Which commands a phone's session runs (its screen read
    // included) is the capture's and the handler's own claim, proved in their own files.
    const commands = runner.calls.filter((call) => call.args[0] !== "version");
    const phoneCommands = commands.filter((call) => call.args[0] === "-P");
    const emulatorCommands = commands.filter((call) => call.args[0] === "-s");
    expect(phoneCommands.length).toBeGreaterThanOrEqual(3);
    for (const call of phoneCommands) {
      expect(call.args.slice(0, 3)).toEqual(["-P", "5037", "-s"]);
      expect(call.args[3]).toBe("R58M123ABC");
      expect(call.options.env).toEqual({
        ANDROID_ADB_SERVER_PORT: "5037",
        ANDROID_HOME: sdk,
      });
    }
    expect(
      phoneCommands.map((call) =>
        call.args[4] === "push"
          ? "push"
          : call.args[5] === "rm"
            ? "rm"
            : call.args[5]?.startsWith("CLASSPATH=")
              ? "server"
              : String(call.args[4]),
      ),
    ).toEqual(expect.arrayContaining(["push", "server", "rm"]));
    expect(emulatorCommands.map((call) => call.args.slice(0, 3))).toEqual([
      ["-s", "emulator-5586", "push"],
      ["-s", "emulator-5586", "shell"],
      ["-s", "emulator-5586", "shell"],
    ]);
    for (const call of emulatorCommands) {
      expect(call.options.env).toEqual(scopedEnv);
    }
  });
});

// why: flushes work until the n-th raw connection has been made, advancing the fake clock so the
// capture's own bounds cannot strand it; an open that died first fails on a named assertion.
async function waitForSocket(
  clock: FakeClock,
  tcp: FakeTcpStreamConnector,
  count: number,
): Promise<void> {
  for (let spent = 0; spent < 60_000 && tcp.connections.length < count; spent += 50) {
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    clock.advance(50);
  }
  expect(tcp.connections.length, "the capture reached its socket").toBe(count);
}

// why: awaits an open with the fake clock turning, so its own 15 s bound can fire while the test waits.
async function driveOpen(clock: FakeClock, opening: Promise<unknown>): Promise<unknown> {
  let done = false;
  void opening.then(
    () => (done = true),
    () => (done = true),
  );
  for (let spent = 0; spent < 60_000 && !done; spent += 50) {
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    clock.advance(50);
  }
  return await opening;
}

/**
 * why: answers every adb call a capture makes by what it is rather than by its place in a queue, so
 * the routing this test reads is proven the same way whether or not the capture reads the phone's
 * screen state first -- the server's shell hangs until the capture's own close kills it, as a live
 * scrcpy server does.
 */
class CaptureRoutingRunner implements ProcessRunner {
  readonly calls: { readonly args: readonly string[]; readonly options: ProcessRunOptions }[] = [];
  #nextPid = 1;

  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    return this.spawn(command, args, options).wait();
  }

  spawn(_command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    this.calls.push({ args, options });
    const rest = args[0] === "-P" ? args.slice(2) : [...args];
    const line = rest.join(" ");
    if (line === "version") {
      return endedHandle(this.#nextPid++, "Android Debug Bridge version 1.0.41\nVersion 35.0.2\n");
    }
    if (line.includes("dumpsys power")) {
      return endedHandle(this.#nextPid++, "  mWakefulness=Awake\n");
    }
    if (rest.includes("shell") && rest.includes("app_process")) {
      return hangingHandle(this.#nextPid++);
    }
    return endedHandle(this.#nextPid++, "");
  }

  spawnStreaming(..._args: Parameters<ProcessRunner["spawnStreaming"]>): never {
    throw new Error("a screen capture spawns no streaming process");
  }
}

function endedHandle(pid: number, stdout: string): ProcessHandle {
  return {
    kill: () => undefined,
    pid,
    stderr: emptyLines(),
    stdout: emptyLines(),
    unref: () => undefined,
    wait: async () => ({ code: 0, stderr: "", stdout }),
  };
}

function hangingHandle(pid: number): ProcessHandle {
  let settle: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => (settle = resolve));
  return {
    kill: () => settle?.(),
    pid,
    stderr: emptyLines(),
    stdout: emptyLines(),
    unref: () => undefined,
    wait: async () => {
      await ended;
      return { code: null, stderr: "", stdout: "" };
    },
  };
}
