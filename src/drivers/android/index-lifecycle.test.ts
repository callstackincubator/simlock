import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeviceTcpError } from "../../core/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  FakeClock,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  NodeProcessSupervisor,
  NodeTcpProbe,
  type ProcessResult,
  type ProcessRunner,
  type ScriptedProcessExpectation,
  SystemClock,
  type TcpStream,
} from "../../ports/index.js";
import {
  AndroidDriver,
  type AndroidDriverDiagnostic,
  type AndroidEmulatorLaunchOptions,
} from "./index.js";
import {
  answeringAvdPath,
  androidFilesystem,
  avdDirectory,
  binaries,
  bootingAt,
  bootProbes,
  makingASeedFrom,
  markWriteExpectation,
  EmulatorExitingRunner,
  makingTheSeed,
  seedEmulatorLine,
  seedStages,
  writeSeedFiles,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  adbServerPort,
  scopedEnv,
  PHYSICAL_DEVICE,
  emulatorLaunchArgs,
  provisionedHarness,
  createDriver,
  EmulatorHost,
  RecordingRunner,
  consolePortOf,
  ok,
  copyPathExpectation,
  WorkingDirectoryFilesystem,
  ANDROID_SDK_ROOT,
  ANDROID_HOME_DIRECTORY,
} from "./testing.js";

const sdk = ANDROID_SDK_ROOT;
const home = ANDROID_HOME_DIRECTORY;

// why: The emulator outlives the daemon, so it is spawned detached; its output goes to the log file in its AVD folder.
const emulatorOptions = {
  env: { ...scopedEnv, ANDROID_EMU_CRASH_REPORTING_DATABASE: `${avdDirectory}/emu-crash.db` },
  stdio: { file: `${avdDirectory}/simlock_one/simlock.avd/emulator.log` },
} as const;

// why: stands in for adb's server: it answers the host protocol with the bytes a test scripts, and says nothing when there are none.
class RepliesTcpStreamConnector extends FakeTcpStreamConnector {
  constructor(private readonly replies: string) {
    super();
  }

  override async connect(port: number): Promise<TcpStream> {
    const stream = await super.connect(port);
    if (this.replies !== "") this.connections.at(-1)?.peer.send(this.replies);
    return stream;
  }
}

// why: stands in for a loopback port that accepts nothing and refuses nothing, so a connect to it never answers.
class HangingTcpStreamConnector extends FakeTcpStreamConnector {
  override connect(): Promise<TcpStream> {
    return new Promise<TcpStream>(() => undefined);
  }
}

describe("AndroidDriver deviceTcp", () => {
  const emulator = {
    address: "emulator-5586",
    deviceId: "simlock_one",
    driverData: { avdName: "simlock_one", configHash: "h", port: 5586, serial: "emulator-5586" },
    physical: false,
  } as const;
  const reverseArgs = (port: number) => [
    "reverse",
    "--no-rebind",
    "tcp:5173",
    `tcp:${String(port)}`,
  ];
  const ok = { code: 0, stderr: "", stdout: "" };
  const adb = (...args: string[]) => ({ args, command: binaries.adb });
  const signal = () => new AbortController().signal;

  async function driverWith(
    expectations: ScriptedProcessExpectation[],
    listeners = new FakeTcpListenerFactory(),
    tcpProbe?: FakeTcpProbe,
  ) {
    const runner = new EmulatorExitingRunner(expectations);
    const driver = await createDriver(await androidFilesystem(), runner, {
      tcpListener: listeners,
      ...(tcpProbe === undefined ? {} : { tcpProbe }),
    });
    return { driver, listeners, runner };
  }

  // fallow-ignore-next-line complexity -- one Tests line: the driver's reverse, its close and each refusal are the cases of one scenario.
  it("sets adb reverse --no-rebind to a loopback listener in 47000-47999 and removes it on close, as an emulator or a phone, keeps the port of a rule that could not be removed until the device's destroy (a phone's reclaim), and refuses with TUNNEL_PORT_IN_USE when adb cannot rebind and TUNNEL_FAILED for any other adb failure or when every tunnel port is busy, and opens a device port for a forward tunnel through the target's adb server (an emulator's configured one, a phone's after its check) with no adb forward rule, and rejects with the check's message when a phone's check is closed, with adb's reason when adb answers FAIL, and with \"timeout\" when adb does not answer in 5 s", async () => {
    const { driver, listeners, runner } = await driverWith([
      { match: adb("-P", "5038", "-s", "emulator-5586", ...reverseArgs(47_002)), result: ok },
      {
        match: adb("-P", "5038", "-s", "emulator-5586", "reverse", "--remove", "tcp:5173"),
        result: ok,
      },
    ]);
    listeners.busy.add(47_000).add(47_001);
    const reverse = await driver.deviceTcp?.reverse(emulator, 5173, signal());
    expect(reverse?.hostPort).toBe(47_002);
    expect(runner.calls[0]?.options.env).toEqual(scopedEnv);
    const arrived: unknown[] = [];
    reverse?.onConnection((stream) => arrived.push(stream));
    listeners.listeners[0]?.connect();
    expect(arrived).toHaveLength(1);
    await reverse?.close();
    expect(runner.calls[1]?.args).toEqual([
      "-P",
      "5038",
      "-s",
      "emulator-5586",
      "reverse",
      "--remove",
      "tcp:5173",
    ]);
    expect(listeners.listeners[0]?.closed).toBe(true);

    const probe = new FakeTcpProbe([5038, 5037]);
    probe.replyWith("OKAY00040029");
    const phoneRun = await driverWith(
      [
        {
          match: adb("version"),
          result: { code: 0, stderr: "", stdout: "Android Debug Bridge version 1.0.41\n" },
        },
        {
          match: adb("-P", "5037", "-s", PHYSICAL_DEVICE.address, ...reverseArgs(47_000)),
          result: ok,
        },
      ],
      new FakeTcpListenerFactory(),
      probe,
    );
    const phone = await phoneRun.driver.deviceTcp?.reverse(PHYSICAL_DEVICE, 5173, signal());
    expect(phone?.hostPort).toBe(47_000);
    expect(phoneRun.runner.calls[1]?.options.env?.ANDROID_ADB_SERVER_PORT).toBe("5037");

    const stuck = await driverWith([
      { match: adb("-P", "5038", "-s", "emulator-5586", ...reverseArgs(47_000)), result: ok },
      {
        match: adb("-P", "5038", "-s", "emulator-5586", "reverse", "--remove", "tcp:5173"),
        result: { code: 1, stderr: "device offline", stdout: "" },
      },
      {
        match: adb(
          "-P",
          "5038",
          "-s",
          "emulator-5586",
          "reverse",
          "--no-rebind",
          "tcp:5174",
          "tcp:47001",
        ),
        result: ok,
      },
    ]);
    const held = await stuck.driver.deviceTcp?.reverse(emulator, 5173, signal());
    const delivered: unknown[] = [];
    held?.onConnection((stream) => delivered.push(stream));
    await held?.close().catch(() => undefined);
    expect(stuck.listeners.listeners[0]?.closed).toBe(false);
    const late = stuck.listeners.listeners[0]?.connect();
    expect({ closed: late?.closed, delivered: delivered.length }).toEqual({
      closed: true,
      delivered: 0,
    });
    const second = await stuck.driver.deviceTcp?.reverse(emulator, 5174, signal());
    expect(second?.hostPort).toBe(47_001);
    await stuck.driver.deviceTcp?.release(emulator);
    expect(stuck.listeners.listeners.map((listener) => listener.closed)).toEqual([true, true]);

    const cannotRebind = await driverWith([
      {
        match: adb("-P", "5038", "-s", "emulator-5586", ...reverseArgs(47_000)),
        result: { code: 1, stderr: "adb.exe: error: cannot rebind existing socket", stdout: "" },
      },
    ]);
    await expect(cannotRebind.driver.deviceTcp?.reverse(emulator, 5173, signal())).rejects.toEqual(
      expect.objectContaining({
        code: "TUNNEL_PORT_IN_USE",
        message: "reverse 5173: the device port is already reversed; remove that rule first",
      }),
    );
    expect(cannotRebind.listeners.listeners[0]?.closed).toBe(true);

    const failed = await driverWith([
      {
        match: adb("-P", "5038", "-s", "emulator-5586", ...reverseArgs(47_000)),
        result: { code: 1, stderr: "x".repeat(300), stdout: "" },
      },
    ]);
    const error = await failed.driver.deviceTcp
      ?.reverse(emulator, 5173, signal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeviceTcpError);
    expect(error).toEqual(
      expect.objectContaining({
        code: "TUNNEL_FAILED",
        message: `reverse 5173: ${"x".repeat(200)}`,
      }),
    );
    expect(failed.listeners.listeners[0]?.closed).toBe(true);

    const busy = new FakeTcpListenerFactory();
    for (let port = 47_000; port < 48_000; port += 1) busy.busy.add(port);
    const exhausted = await driverWith([], busy);
    await expect(exhausted.driver.deviceTcp?.reverse(emulator, 5173, signal())).rejects.toEqual(
      expect.objectContaining({
        code: "TUNNEL_FAILED",
        message: "no free tunnel port on the worker",
      }),
    );
    expect(exhausted.runner.calls).toEqual([]);

    const connectWith = async (
      device: typeof emulator | typeof PHYSICAL_DEVICE,
      adbReplies: string,
      options: { readonly probe?: FakeTcpProbe; readonly port?: number } = {},
    ) => {
      const connector = new RepliesTcpStreamConnector(adbReplies);
      const clock = new FakeClock();
      const runner = new EmulatorExitingRunner(
        options.probe === undefined
          ? []
          : [
              {
                match: adb("version"),
                result: { code: 0, stderr: "", stdout: "Android Debug Bridge version 1.0.41\n" },
              },
            ],
      );
      const driver = await createDriver(await androidFilesystem(), runner, {
        clock,
        ...(options.port === undefined ? {} : { driverConfig: { adbServerPort: options.port } }),
        tcpListener: new FakeTcpListenerFactory(),
        ...(options.probe === undefined ? {} : { tcpProbe: options.probe }),
        tcpStreamConnector: connector,
      });
      const connecting = driver.deviceTcp?.connect(device, 8081, signal());
      return { clock, connecting, connector, runner };
    };

    const opened = await connectWith(emulator, "OKAYOKAY", { port: 5050 });
    await expect(opened.connecting).resolves.toBeDefined();
    expect(opened.connector.connections.map(({ port }) => port)).toEqual([5050]);
    expect(opened.connector.connections[0]?.peer.writtenText()).toBe(
      "001chost:transport:emulator-55860008tcp:8081",
    );
    expect(opened.runner.calls).toEqual([]);

    const closedProbe = new FakeTcpProbe([5038, 5037]);
    closedProbe.replyWith("OKAY00040028");
    const gated = await connectWith(PHYSICAL_DEVICE, "OKAYOKAY", { probe: closedProbe });
    await expect(gated.connecting).rejects.toThrow(/speaks protocol 40/);
    expect(gated.connector.connections).toEqual([]);

    const refused = await connectWith(emulator, "OKAYFAIL0006closed");
    await expect(refused.connecting).rejects.toEqual(
      expect.objectContaining({ code: "TUNNEL_FAILED", message: "closed" }),
    );

    const silent = await connectWith(emulator, "");
    // why: the connect is pending only once the socket is open and waiting for adb's answer; a timer alone is set before that.
    await vi.waitFor(() => expect(silent.connector.connections).toHaveLength(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(silent.clock.pendingTimerCount).toBeGreaterThan(0);
    silent.clock.advance(4_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(silent.connector.connections[0]?.peer.closed).toBe(false);
    silent.clock.advance(1);
    await expect(silent.connecting).rejects.toEqual(
      expect.objectContaining({ code: "TUNNEL_FAILED", message: "timeout" }),
    );
  });

  it("connects an emulator port to the worker port above the emulator's console port, refuses a phone, and rejects with the connector's reason when nothing listens and with \"timeout\" when nothing answers in 5 s", async () => {
    const connector = new FakeTcpStreamConnector();
    const clock = new FakeClock();
    const driver = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      clock,
      tcpListener: new FakeTcpListenerFactory(),
      tcpStreamConnector: connector,
    });
    const tcp = driver.deviceTcp;
    const second = { ...emulator, address: "emulator-5682" };

    expect(tcp?.supportsEmulatorPort(emulator)).toBe(true);
    expect(tcp?.supportsEmulatorPort(PHYSICAL_DEVICE)).toBe(false);
    await tcp?.connectEmulatorPort(emulator, "adb", signal());
    await tcp?.connectEmulatorPort(second, "adb", signal());
    expect(connector.connections.map(({ host, port }) => `${host}:${String(port)}`)).toEqual([
      "127.0.0.1:5587",
      "127.0.0.1:5683",
    ]);

    await expect(tcp?.connectEmulatorPort(PHYSICAL_DEVICE, "adb", signal())).rejects.toEqual(
      expect.objectContaining({
        code: "TUNNEL_UNSUPPORTED",
        message:
          "emulator adb: the lease is on an Android phone; emulator ports need an Android emulator",
      }),
    );
    await expect(
      tcp?.connectEmulatorPort({ ...emulator, address: "" }, "adb", signal()),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "TUNNEL_FAILED",
        message: "the emulator has no adb port yet",
      }),
    );

    const bare = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      clock,
      tcpListener: new FakeTcpListenerFactory(),
    });
    await expect(bare.deviceTcp?.connectEmulatorPort(emulator, "adb", signal())).rejects.toEqual(
      expect.objectContaining({
        code: "TUNNEL_FAILED",
        message: "the emulator has no adb port yet",
      }),
    );

    connector.refusedPorts.add(5587);
    await expect(tcp?.connectEmulatorPort(emulator, "adb", signal())).rejects.toEqual(
      expect.objectContaining({
        code: "TUNNEL_FAILED",
        message: "connect ECONNREFUSED 127.0.0.1:5587",
      }),
    );

    const silent = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      clock,
      tcpListener: new FakeTcpListenerFactory(),
      tcpStreamConnector: new HangingTcpStreamConnector(),
    });
    const waiting = Promise.resolve(
      silent.deviceTcp?.connectEmulatorPort(emulator, "adb", signal()),
    );
    const state = promiseState(waiting);
    clock.advance(4_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.state).toBe("pending");
    clock.advance(1);
    await expect(waiting).rejects.toEqual(
      expect.objectContaining({ code: "TUNNEL_FAILED", message: "timeout" }),
    );
  });

  it("sweeps at start only the reverse rules into 47000-47999 on an idle device proved its own, only reads a leased device's rules and keeps their ports from the next reverse until its destroy, touches nothing on an emulator that answers as another's, and on an idle phone removes nothing and keeps the ports its rules point to from the next reverse", async () => {
    const own = await driverWith([
      avdPathExpectation("emulator-5586"),
      {
        match: adb("-P", "5038", "-s", "emulator-5586", "reverse", "--list"),
        result: {
          code: 0,
          stderr: "",
          stdout:
            "host-19 tcp:5173 tcp:47003\nhost-19 tcp:8081 tcp:8082\nhost-19 tcp:3000 tcp:47999\n",
        },
      },
      {
        match: adb("-P", "5038", "-s", "emulator-5586", "reverse", "--remove", "tcp:5173"),
        result: ok,
      },
      {
        match: adb("-P", "5038", "-s", "emulator-5586", "reverse", "--remove", "tcp:3000"),
        result: ok,
      },
    ]);
    await own.driver.deviceTcp?.sweep([{ device: emulator, leased: false }]);
    expect(own.runner.calls.filter((call) => call.args.includes("--remove"))).toHaveLength(2);

    const probe = new FakeTcpProbe([5038, 5037]);
    probe.replyWith("OKAY00040029");
    const phones = await driverWith(
      [
        {
          match: adb("version"),
          result: { code: 0, stderr: "", stdout: "Android Debug Bridge version 1.0.41\n" },
        },
        {
          match: adb("-P", "5037", "-s", PHYSICAL_DEVICE.address, "reverse", "--list"),
          result: {
            code: 0,
            stderr: "",
            stdout: "UsbFfs tcp:5173 tcp:47000\nUsbFfs tcp:3000 tcp:3001\n",
          },
        },
        {
          match: adb(
            "-P",
            "5037",
            "-s",
            PHYSICAL_DEVICE.address,
            "reverse",
            "--no-rebind",
            "tcp:5174",
            "tcp:47001",
          ),
          result: ok,
        },
      ],
      new FakeTcpListenerFactory(),
      probe,
    );
    await phones.driver.deviceTcp?.sweep([{ device: PHYSICAL_DEVICE, leased: false }]);
    const onPhone = await phones.driver.deviceTcp?.reverse(PHYSICAL_DEVICE, 5174, signal());
    expect(onPhone?.hostPort).toBe(47_001);
    expect(phones.runner.calls.some((call) => call.args.includes("--remove"))).toBe(false);

    const foreign = await driverWith([avdPathExpectation("emulator-5586", "simlock_two")]);
    await foreign.driver.deviceTcp?.sweep([{ device: emulator, leased: false }]);
    expect(foreign.runner.calls.some((call) => call.args.includes("reverse"))).toBe(false);

    const onServer = ["-P", "5038", "-s", "emulator-5586"];
    const leased = await driverWith([
      avdPathExpectation("emulator-5586"),
      {
        match: adb(...onServer, "reverse", "--list"),
        result: {
          code: 0,
          stderr: "",
          stdout: "host-19 tcp:5173 tcp:47000\nhost-19 tcp:3000 tcp:3001\n",
        },
      },
      {
        match: adb(...onServer, "reverse", "--no-rebind", "tcp:5174", "tcp:47001"),
        result: ok,
      },
      {
        match: adb(...onServer, "reverse", "--no-rebind", "tcp:5175", "tcp:47000"),
        result: ok,
      },
    ]);
    await leased.driver.deviceTcp?.sweep([{ device: emulator, leased: true }]);
    expect(leased.runner.calls.filter((call) => call.args.includes("--remove"))).toEqual([]);
    const next = await leased.driver.deviceTcp?.reverse(emulator, 5174, signal());
    expect(next?.hostPort).toBe(47_001);
    await leased.driver.deviceTcp?.release(emulator);
    const afterReclaim = await leased.driver.deviceTcp?.reverse(emulator, 5175, signal());
    expect(afterReclaim?.hostPort).toBe(47_000);
  });
});

describe("AndroidDriver tunnels of a destroyed device", () => {
  it("closes the loopback listeners held for a virtual device's tunnels when the device is destroyed", async () => {
    const listeners = new FakeTcpListenerFactory();
    const harness = await provisionedHarness({
      afterwards: [
        processResult(binaries.adb, [
          "-P",
          "5038",
          "-s",
          "emulator-5586",
          "reverse",
          "--no-rebind",
          "tcp:5173",
          "tcp:47000",
        ]),
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ],
      tcpListener: listeners,
    });
    const ready = await harness.driver.makeReady(harness.device);
    await harness.driver.deviceTcp?.reverse(
      { ...ready, physical: false },
      5173,
      new AbortController().signal,
    );
    expect(listeners.listeners.map((listener) => listener.closed)).toEqual([false]);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );

    const destroying = harness.driver.destroy(ready);
    harness.runner.handles[launch]?.kill("SIGTERM");
    await destroying;

    expect(listeners.listeners.map((listener) => listener.closed)).toEqual([true]);
  });
});

describe("AndroidDriver readiness on a taken console port", () => {
  it("refuses to ready a device whose serial an emulator of an AVD outside its root answers, and changes nothing on that emulator, even when the device is then shut down (#256)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const machine = new PortTakingMachine(host);
    const driver = await createDriver(filesystem, machine.runner(), { ids: ["one"] });
    await driver.resolveSpec(spec);
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(stopped);

    // why: Another emulator takes the device's console port before its own emulator binds it --
    // whatever freed the port for it (#52, a second Simlock instance, the user's own
    // emulator). Its AVD is named like Simlock's but lives in the user's AVD home: a name
    // proves nothing, root membership does (safety rule 8).
    const otherPath = `${home}/.android/avd/simlock_one.avd`;
    const other = machine.takePortOnNextBoot(otherPath);

    const readied = await driver.makeReady(stopped).then(
      (ready) => machine.avdPathAnswering(ready.address),
      (error: unknown) => driverCrashMessage(error),
    );
    // why: What the core does with a device whose boot failed: it destroys it, and destroying a
    // device starts by shutting it down.
    await driver.shutdown(stopped);

    const ownPath = `${avdDirectory}/simlock_one/simlock.avd`;
    expect({ readied, other: other.observed() }).toEqual({
      readied: {
        refused: expect.stringMatching(
          new RegExp(`"${escapeRegExp(otherPath)}".* ${escapeRegExp(ownPath)}(\\s|$)`),
        ),
      },
      other: { running: true, sentByDriver: [] },
    });
  });

  it.each<{
    readonly reported: string;
    readonly answer: string;
    readonly filesystem?: () => MemoryFilesystem;
  }>([
    { answer: `${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`, reported: "exactly" },
    {
      answer: `${avdDirectory}/simlock_one/simlock.avd/\r\nOK\r\n`,
      reported: "with a trailing slash",
    },
    {
      answer: `/private${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`,
      reported: "through a link to the device root's directory",
    },
    // why: `/home` is a link to `/private/home`, as macOS's `/var` is to `/private/var`: the link
    // is on the device root's side, and the emulator answers with the resolved path.
    {
      answer: `/private${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`,
      filesystem: () => new LinkedHomeFilesystem(),
      reported: "resolved, when the device root's own path runs through a link",
    },
  ])(
    "readies a device whose emulator reports its AVD directory $reported",
    async ({ answer, filesystem: createFilesystem, reported }) => {
      const filesystem = await androidFilesystem({}, createFilesystem?.());
      if (createFilesystem === undefined) filesystem.defineSymlink("/private/home", "/home");
      const host = new EmulatorHost(filesystem);
      const override = overridingAvdPath(host.runner());
      const driver = await createDriver(filesystem, override.runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      const device = await driver.provision(spec);
      override.answer(ok(answer));
      if (reported === "exactly") {
        // why: An exact answer needs nothing from the filesystem: a directory that cannot be
        // resolved this moment does not fail the boot.
        filesystem.defineFailure(`${avdDirectory}/simlock_one/simlock.avd`, "EACCES");
      }

      const ready = await driver.makeReady(device);

      expect(ready.address).toBe("emulator-5586");
    },
  );

  it.each<{
    readonly answered: string;
    readonly answer: ProcessResult;
    readonly filesystem?: () => MemoryFilesystem;
    readonly existing?: string;
  }>([
    { answer: ok("KO: unknown command\r\n"), answered: "a console error" },
    {
      answer: { code: 1, stderr: "error: could not connect to console", stdout: "" },
      answered: "a failed adb call",
    },
    {
      answer: ok(`/private/elsewhere/simlock_one/simlock.avd\r\nOK\r\n`),
      answered: "a directory that does not exist",
    },
    {
      answer: ok(`${avdDirectory}/simlock_two/simlock.avd\r\nOK\r\n`),
      answered: "another device's directory in the same root",
      existing: `${avdDirectory}/simlock_two/simlock.avd`,
    },
    {
      answer: ok(`${home}/.android/avd/simlock_one/simlock.avd\r\nOK\r\n`),
      answered: "a directory of the same name outside the root",
      existing: `${home}/.android/avd/simlock_one/simlock.avd`,
    },
    {
      answer: ok(`\r\n${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`),
      answered: "its own directory below a blank first line",
    },
    {
      // why: Resolved against the daemon's working directory, which here is the device root, a
      // relative answer would name the device's own directory -- by accident.
      answer: ok("simlock_one/simlock.avd\r\nOK\r\n"),
      answered: "a relative path",
      filesystem: () => new WorkingDirectoryFilesystem(avdDirectory),
    },
  ])(
    "refuses to ready a device whose emulator answers the AVD path query with $answered, and stops that emulator",
    async ({ answer, existing, filesystem: createFilesystem }) => {
      const filesystem = await androidFilesystem({}, createFilesystem?.());
      if (existing !== undefined) await filesystem.mkdirp(existing);
      const host = new EmulatorHost(filesystem);
      const override = overridingAvdPath(host.runner());
      const driver = await createDriver(filesystem, override.runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      const device = await driver.provision(spec);
      override.answer(answer);

      const readied = await driver.makeReady(device).then(
        () => "readied",
        (error: unknown) => driverCrashMessage(error),
      );

      expect({ readied, running: host.avdAnswering("emulator-5586") }).toEqual({
        readied: { refused: expect.any(String) },
        running: undefined,
      });
    },
  );
});

describe("AndroidDriver emulator registration", () => {
  it("sweeps its own console range when it takes over a server, and nobody else's", async () => {
    // why: A running emulator announced itself exactly once, to a server a previous daemon has
    // since reaped. With `ADB_EMU=0` nothing rediscovers it, so `simlock daemon stop` would
    // otherwise orphan gigabytes of RSS the driver can no longer see, and hand the console
    // port it is sitting on to the next emulator, which then cannot bind.
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    await createDriver(filesystem, new EmulatorExitingRunner([]), { tcpProbe });

    const announced = tcpProbe.sends.map((send) => send.payload);
    expect(announced).toHaveLength(49);
    expect(announced[0]).toBe("0012host:emulator:5587");
    expect(announced.at(-1)).toBe("0012host:emulator:5683");
    // why: Every send goes to Simlock's own server, and every port is inside Simlock's range:
    // one below 5587 would be adb connecting to an emulator of the user's.
    expect(tcpProbe.sends.every((send) => send.port === adbServerPort)).toBe(true);
  });

  it("finishes the sweep when a port refuses the announcement", async () => {
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(
      createDriver(filesystem, new EmulatorExitingRunner([]), { tcpProbe }),
    ).resolves.toBeDefined();
    expect(tcpProbe.sends).toHaveLength(49);
  });

  it("re-announces an emulator that stays unreachable, since nothing else will", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 2 });
    // why: Nothing is announced when an emulator is spawned: adb answers `host:emulator:<port>`
    // by connecting out to that port, and the emulator has not opened it yet.
    const afterSweep = harness.tcpProbe.sends.length;
    const probedBefore = bootProbes(harness.runner);
    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(probedBefore + 1));
    expect(harness.tcpProbe.sends).toHaveLength(afterSweep);

    // why: Past the grace period on the second failure: adb's own reconnect queue is drained by
    // the scanner thread, which `ADB_EMU=0` does not run.
    harness.clock.advance(6_000);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(probedBefore + 2));
    await vi.waitFor(() =>
      expect(harness.tcpProbe.sends.slice(afterSweep)).toEqual([
        { payload: "0012host:emulator:5587", port: adbServerPort },
      ]),
    );

    harness.clock.advance(2_000);
    await expect(ready).resolves.toMatchObject({ address: "emulator-5586" });
  });

  it("never fails a boot because a registration failed", async () => {
    const harness = await provisionedHarness();
    harness.tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(harness.driver.makeReady(harness.device)).resolves.toMatchObject({
      deviceId: "simlock_one",
    });
  });
});

function recordKillTimeout(
  into: (number | undefined)[],
  command: string,
  args: readonly string[],
  timeoutMs: number | undefined,
): void {
  if (command === binaries.adb && args.slice(2).join(" ") === "emu kill") into.push(timeoutMs);
}

describe("AndroidDriver console ports across a restart", () => {
  it("stops a discovered running emulator before deleting its AVD after a restart", async () => {
    const filesystem = new RemovalObservingFilesystem();
    await androidFilesystem({}, filesystem);
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const inner = host.runner();
    const runningAtDeletion: (string | undefined)[] = [];
    const killTimeouts: (number | undefined)[] = [];
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        recordKillTimeout(killTimeouts, command, args, options?.timeoutMs);
        return inner.run(command, args, options);
      },
    };
    filesystem.onRemove = (path) => {
      if (path === `${avdDirectory}/${running.deviceId}`) {
        runningAtDeletion.push(host.avdAnswering(running.address));
      }
    };
    const after = await createDriver(filesystem, runner);
    const reality = await after.listManaged();
    const orphan = reality.devices[0]!;
    expect(orphan).toMatchObject({ deviceId: running.deviceId, runState: "running" });
    expect(host.avdAnswering(running.address)).toBe(running.deviceId);

    await after.destroy(orphan);

    expect(runningAtDeletion, "the emulator must have exited before AVD deletion").toEqual([
      undefined,
    ]);
    expect(killTimeouts, "the kill must be bounded").toEqual([5_000]);
    expect(await filesystem.exists(`${avdDirectory}/${running.deviceId}`)).toBe(false);
  });

  it("refuses to delete the AVD of a discovered emulator that does not exit", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const inner = host.runner();
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) =>
        args.includes("kill") ? ok() : inner.run(command, args, options),
    };
    const clock = new FakeClock();
    const after = await createDriver(filesystem, runner, { bootTimeoutMs: 600_000, clock });
    const orphan = (await after.listManaged()).devices[0]!;

    const destroyed = after.destroy(orphan);
    const refused = expect(destroyed).rejects.toThrow("did not exit");
    const state = promiseState(destroyed);
    await vi.waitFor(() => expect(clock.pendingTimerCount).toBeGreaterThan(0));
    // why: each poll arms the next delay only after the previous one fired, so the clock moves in steps.
    for (let elapsed = 0; elapsed < 179_999; elapsed += 1_000) {
      clock.advance(Math.min(1_000, 179_999 - elapsed));
      for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    }
    expect(state.state, "still waiting just before 180 s, whatever the boot deadline").toBe(
      "pending",
    );
    clock.advance(1);
    await refused;

    expect(await filesystem.exists(`${avdDirectory}/${running.deviceId}`)).toBe(true);
  });

  it("refuses to delete the AVD when an attached emulator cannot say which AVD it runs", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    const inner = answeringAvdPath(binaries.adb, host.runner(), {
      code: 1,
      stderr: "error",
      stdout: "",
    });
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        if (command === binaries.adb) calls.push({ args, timeoutMs: options?.timeoutMs });
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner);
    const orphan = (await after.listManaged()).devices[0]!;

    await expect(after.destroy(orphan)).rejects.toThrow("could not tell which AVD");

    expect({
      kills: calls.filter((call) => call.args.includes("kill")).length,
      probeTimeoutMs: calls.find((call) => call.args.includes("path"))?.timeoutMs,
      kept: await filesystem.exists(`${avdDirectory}/${running.deviceId}`),
      running: host.avdAnswering(running.address),
    }).toEqual({ kills: 0, probeTimeoutMs: 5_000, kept: true, running: running.deviceId });
  });

  it("never kills an emulator that runs a different AVD when deleting a discovered one", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const kills: string[] = [];
    const inner = answeringAvdPath(
      binaries.adb,
      host.runner(),
      ok(`${avdDirectory}/simlock_other.avd\nOK\n`),
    );
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        if (args.includes("kill")) kills.push(args.join(" "));
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner);
    const orphan = (await after.listManaged()).devices[0]!;

    await after.destroy(orphan);

    expect({ kills, running: host.avdAnswering(running.address) }).toEqual({
      kills: [],
      running: running.deviceId,
    });
  });

  it("a shutdown after a restart sends no kill, snapshot load or rule removal to another device on the stored serial (#284)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const runner = new RecordingRunner(host.runner());
    const after = await createDriver(filesystem, runner, { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    expect(running.address).toBe(stopped.address);
    expect(host.avdAnswering(running.address)).toBe("simlock_two");
    const callStart = runner.calls.length;

    await after.shutdown(stopped).then(() => undefined, driverCrashMessage);

    expect({
      running: host.avdAnswering(running.address),
      ruleCalls: runner.calls
        .slice(callStart)
        .filter(
          (call) =>
            call.args.includes(running.address) &&
            (call.args.includes("reverse") || call.args.includes("forward")),
        )
        .map((call) => call.args),
      mutations: runner.calls
        .slice(callStart)
        .filter(
          (call) =>
            call.command === binaries.adb &&
            call.args[1] === running.address &&
            (call.args.slice(2).join(" ") === "emu kill" ||
              call.args.slice(2, 6).join(" ") === "emu avd snapshot load"),
        )
        .map((call) => call.args),
    }).toEqual({ running: "simlock_two", ruleCalls: [], mutations: [] });
  });

  it("sends no kill when the stored serial's identity cannot be read, and gives the probe a timeout (#284)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const inner = host.runner();
    let unreachable = false;
    const runner = new RecordingRunner({
      run: async (command, args, options) =>
        unreachable && command === binaries.adb && args.slice(2).join(" ") === "emu avd path"
          ? { code: 1, stderr: "unreachable", stdout: "" }
          : await inner.run(command, args, options),
      spawn: (...args) => inner.spawn(...args),
      spawnStreaming: (...args) => inner.spawnStreaming(...args),
    });
    const after = await createDriver(filesystem, runner, { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    unreachable = true;
    const callStart = runner.calls.length;

    await after.shutdown(stopped).catch(() => undefined);

    const calls = runner.calls.slice(callStart);
    expect(calls.filter((call) => call.args.slice(2).join(" ") === "emu kill")).toEqual([]);
    expect(host.avdAnswering(running.address)).toBe("simlock_two");
    expect(
      calls.find((call) => call.args.slice(2).join(" ") === "emu avd path")?.options.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it("readies a stopped device and one provisioned after a restart each at an address its own emulator answers (#52)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);

    // why: The first daemon: provision, boot and stop a device. Stopped, it holds its console
    // port only in its driver data -- nothing is listening there any more. Each call gets
    // the device as the last one returned it, which is what the registry commits.
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const after = await createDriver(filesystem, host.runner(), { ids: ["two"] });
    await after.resolveSpec(spec);
    const provisioned = await after.provision(spec);
    const readyProvisioned = await after.makeReady(provisioned);
    const readyStopped = await after.makeReady(stopped);

    expect({
      provisioned: host.avdAnswering(readyProvisioned.address),
      stopped: host.avdAnswering(readyStopped.address),
    }).toEqual({ provisioned: "simlock_two", stopped: "simlock_one" });
  });
});

describe("AndroidDriver console port reservations", () => {
  const spec = { physical: false, model: "Pixel 5", osVersion: "34", platform: "android" } as const;

  it("keeps a device's console port across its stops, so a call on its stopped record reaches no other device", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    // why: The first provision makes the seed, which takes the id after its device's; each boot's mark write takes the next.
    const driver = await createDriver(filesystem, host.runner(), {
      ids: ["one", "seed", "mark-1", "two", "mark-2", "mark-3"],
    });
    await driver.resolveSpec(spec);
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(stopped);
    const running = await driver.makeReady(await driver.provision(spec));

    await driver.shutdown(stopped);

    expect({
      rebooted: (await driver.makeReady(stopped)).address,
      running: host.avdAnswering(running.address),
    }).toEqual({ rebooted: stopped.address, running: "simlock_two" });
  });

  it("gives a deleted device's console port back to the next boot", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const driver = await createDriver(filesystem, host.runner(), {
      ids: ["one", "mark-1", "two", "mark-2"],
    });
    await driver.resolveSpec(spec);
    const deleted = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(deleted);
    await driver.destroy(deleted);

    const next = await driver.makeReady(await driver.provision(spec));

    expect(next.address).toBe(deleted.address);
  });

  it("never stops the emulator now on a stopped device's old console port when deleting that device after a restart", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);
    const after = await createDriver(filesystem, host.runner(), { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    // why: Nothing reserves a stopped device's port after a restart, so the next boot took it.
    expect(running.address).toBe(stopped.address);

    await after.destroy(stopped);

    expect(host.avdAnswering(running.address)).toBe("simlock_two");
  });
});

const live = process.env.SIMLOCK_LIVE_ANDROID === "1" ? it : it.skip;

live(
  "live smoke: provision, boot from the boot snapshot, restart, and destroy",
  async () => {
    const driver = await AndroidDriver.create({
      clock: new SystemClock(),
      database: await memoryAndroidSourceDatabase(),
      driverConfig: {},
      env: process.env,
      filesystem: new NodeFilesystem(),
      homeDirectory: process.env.HOME ?? home,
      hostAbi: "arm64-v8a",
      instanceId: `live-${process.pid}`,
      processRunner: new NodeProcessRunner(),
      processSupervisor: new NodeProcessSupervisor({
        platform: process.platform,
        processRunner: new NodeProcessRunner(),
      }),
      simlockHome: join(tmpdir(), `simlock-live-android-${process.pid}`),
      tcpProbe: new NodeTcpProbe(),
    });
    const spec = await driver.resolveSpec({
      model: process.env.SIMLOCK_LIVE_ANDROID_MODEL ?? "Pixel 5",
      platform: "android",
      ...(process.env.SIMLOCK_LIVE_ANDROID_API === undefined
        ? {}
        : { osVersion: process.env.SIMLOCK_LIVE_ANDROID_API }),
    });
    const device = await driver.provision(spec);

    try {
      const ready = await driver.makeReady(device);
      await driver.shutdown(ready);
      const restarted = await driver.makeReady(ready);

      expect(restarted.address).toMatch(/^emulator-\d+$/);
    } finally {
      await driver.destroy(device);
    }
  },
  480_000,
);

describe("AndroidDriver image fit", () => {
  describe("seeds and copies", () => {
    const sources = `${avdDirectory}/sources`;
    const copyHome = `${avdDirectory}/simlock_one`;
    const seedHome = `${sources}/seed_two`;
    async function seedHarness(
      expectations: readonly ScriptedProcessExpectation[],
      options: {
        readonly clock?: FakeClock;
        readonly config?: string;
        readonly filesystem?: MemoryFilesystem;
        readonly ids?: readonly string[];
        readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
      } = {},
    ) {
      const filesystem = await androidFilesystem({}, options.filesystem);
      await writeSeedFiles(filesystem, seedHome, options.config);
      const database = await memoryAndroidSourceDatabase();
      const runner = new EmulatorExitingRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        ...expectations,
      ]);
      const driver = await createDriver(filesystem, runner, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
        database,
        ids: options.ids ?? ["one", "two", "three"],
      });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      return { database, driver, filesystem, runner, spec };
    }

    /** why: the daemon after a restart: a new driver over the same device folders and the same source table. */
    async function reopened(
      harness: Awaited<ReturnType<typeof seedHarness>>,
      expectations: readonly ScriptedProcessExpectation[],
      options: {
        readonly clock?: FakeClock;
        readonly emulator?: AndroidEmulatorLaunchOptions;
      } = {},
    ) {
      const runner = new EmulatorExitingRunner([...expectations]);
      const driver = await createDriver(harness.filesystem, runner, {
        ...options,
        database: harness.database,
        ids: ["four", "five", "six"],
      });
      return { driver, runner };
    }

    it("hands the seeds part its clock, its source table, its device root and its id generator", async () => {
      const clock = new FakeClock(5_000);
      const harness = await seedHarness(makingTheSeed(), { clock });

      await harness.driver.provision(harness.spec);

      expect(
        harness.database
          .prepare("SELECT source_id, folder, created_at FROM android_source_data")
          .all(),
      ).toEqual([{ created_at: 5_000, folder: seedHome, source_id: "seed_two" }]);
    });

    it("hands the avd config the emulator launch settings, so a seed made under other ones is stale", async () => {
      const harness = await seedHarness(makingTheSeed());
      await harness.driver.provision(harness.spec);

      const restarted = await reopened(
        harness,
        [processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9")],
        { emulator: { audio: true, bootAnimation: true, gpu: "auto", headless: true } },
      );

      await expect(restarted.driver.listSources()).resolves.toMatchObject([
        { id: "seed_two", staleReason: "android.emulator launch settings changed" },
      ]);
    });

    it("leases a plain Android device from a copy of the kind's seed, made first when there is none, booted from the boot snapshot", async () => {
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true),
        markWriteExpectation("emulator-5586", "three"),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);

      const device = await harness.driver.provision(harness.spec);
      const ready = await harness.driver.makeReady(device);

      const create = harness.runner.calls.find((call) => call.args[0] === "create");
      expect(create?.options.env).toMatchObject({ ANDROID_AVD_HOME: seedHome });
      expect(device).toMatchObject({
        deviceId: "simlock_one",
        driverData: { avdHome: copyHome, avdName: "simlock" },
      });
      await expect(harness.filesystem.readFile(`${copyHome}/simlock.avd/config.ini`)).resolves.toBe(
        "hw.ramSize=2048\nsimlock.mark=three\n",
      );
      await expect(harness.filesystem.readFile(`${copyHome}/simlock.ini`)).resolves.toBe(
        `avd.ini.encoding=UTF-8\npath=${copyHome}/simlock.avd\ntarget=android-34\n`,
      );
      await expect(harness.driver.listSources()).resolves.toMatchObject([
        {
          id: "seed_two",
          imageTag: "google_apis",
          kind: "seed",
          model: "Pixel 5",
          osVersion: "34",
        },
      ]);
      const launches = harness.runner.calls.filter((call) => call.args.includes("-avd"));
      expect(launches.map((call) => call.options.env?.["ANDROID_AVD_HOME"])).toEqual([
        seedHome,
        seedHome,
        copyHome,
      ]);
      expect(launches.flatMap((call) => call.args)).not.toContain("-wipe-data");
      const shellRuns = harness.runner.calls.filter(
        (call) => call.args.includes("sync") || call.args.includes("-p"),
      );
      expect(
        shellRuns.map((call) => [call.args.at(-1), call.options.timeoutMs]),
        "the seed's sync and power-off are each bounded, so a wedged adbd cannot hold the make",
      ).toEqual([
        ["sync", 60_000],
        ["-p", 60_000],
      ]);
      expect(ready.address).toBe("emulator-5586");
    });

    it("reports a copy whose boot snapshot does not load by its device id, only when it took over 12 s, and never wipes it", async () => {
      for (const { readyAfterMs, reported } of [
        { readyAfterMs: 12_000, reported: false },
        { readyAfterMs: 12_001, reported: true },
      ]) {
        const clock = new FakeClock();
        const diagnostics: AndroidDriverDiagnostic[] = [];
        const harness = await seedHarness(
          [
            ...makingTheSeed(),
            processResult(binaries.adb, ["devices"], "List of devices attached\n"),
            ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true, 1),
            markWriteExpectation("emulator-5586", "three"),
          ],
          { clock, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
        );
        const device = await harness.driver.provision(harness.spec);

        const ready = harness.driver.makeReady(device);
        await vi.waitFor(() =>
          expect(
            harness.runner.calls.filter((call) => call.args.includes("sys.boot_completed")),
          ).toHaveLength(3),
        );
        clock.advance(readyAfterMs);
        await ready;

        expect(diagnostics).toEqual(
          reported ? [{ deviceId: "simlock_one", kind: "snapshot-cold-boot", readyAfterMs }] : [],
        );
        expect(harness.runner.calls.flatMap((call) => call.args)).not.toContain("-wipe-data");
      }
    });

    describe("saveSource", () => {
      const savedHome = `${sources}/baseline_four`;
      const serial = "emulator-5586";
      const config =
        "hw.device.name=pixel_5\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\nhw.ramSize=2048\n";
      const ids = ["one", "two", "three", "four"];
      const adbShell = (command: string) =>
        processResult(binaries.adb, ["-s", serial, "shell", command]);
      const sourceBoot = () => {
        const stage = seedStages(savedHome);
        return [
          stage.devices,
          ...stage.secondBoot,
          stage.save,
          stage.list,
          stage.probe,
          stage.kill,
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ];
      };
      const leasing = (hangs: boolean) => [
        ...makingTheSeed(),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], hangs),
        markWriteExpectation(serial, "three"),
      ];
      const probe = processResult(
        binaries.adb,
        ["-s", serial, "emu", "avd", "path"],
        `${copyHome}/simlock.avd\r\nOK\r\n`,
      );
      const savingSteps = [
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        probe,
        adbShell("sync"),
        processResult(binaries.adb, ["-s", serial, "shell", "reboot", "-p"]),
      ];

      it("provisions a device named after a baseline source as a copy of that source's folder with no seed made and only the emulator's version read, and refuses a source whose system image is gone", async () => {
        const version = () =>
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9");
        const harness = await seedHarness(
          [...leasing(true), ...savingSteps, ...sourceBoot(), version(), version()],
          {
            config,
            ids: [...ids, "five", "six"],
          },
        );
        const ready = await harness.driver.makeReady(await harness.driver.provision(harness.spec));
        await harness.driver.saveSource({ ...ready, physical: false as const });
        await harness.filesystem.writeFileAtomic(`${savedHome}/simlock.avd/marker.txt`, "saved");
        const callsBefore = harness.runner.calls.length;

        const copy = await harness.driver.provision(harness.spec, { source: "baseline_four" });

        expect(copy.deviceId).toBe("simlock_five");
        await expect(
          harness.filesystem.readFile(`${avdDirectory}/simlock_five/simlock.avd/marker.txt`),
        ).resolves.toBe("saved");
        expect(harness.runner.calls).toHaveLength(callsBefore + 1);

        await harness.filesystem.rm(`${sdk}/system-images/android-34/google_apis/arm64-v8a`);
        await expect(
          harness.driver.provision(harness.spec, { source: "baseline_four" }),
        ).rejects.toThrow(
          "source baseline_four is stale: system image system-images;android-34;google_apis;arm64-v8a is not installed",
        );
        expect(await harness.filesystem.exists(`${avdDirectory}/simlock_six`)).toBe(false);
      });

      it("keeps a powered-off copy of the device as a ready baseline source with one boot snapshot, powering the emulator off first, or killing it when it will not leave in 60 s, or polling adb with no process handle", async () => {
        const kept = async (harness: Awaited<ReturnType<typeof seedHarness>>) => {
          expect(await harness.filesystem.exists(`${savedHome}/simlock.avd/config.ini`)).toBe(true);
          await expect(harness.filesystem.readFile(`${savedHome}/simlock.ini`)).resolves.toContain(
            `path=${savedHome}/simlock.avd`,
          );
          expect(await harness.filesystem.exists(copyHome)).toBe(true);
          const listed = await harness.driver.listSources();
          expect(listed.find((source) => source.id === "baseline_four")).toMatchObject({
            imageTag: "google_apis",
            kind: "baseline",
            model: "pixel_5",
            osVersion: "34",
          });
          expect(
            harness.database
              .prepare("SELECT state FROM android_source_data WHERE source_id = 'baseline_four'")
              .all(),
          ).toEqual([{ state: "ready" }]);
        };
        const sent = (harness: Awaited<ReturnType<typeof seedHarness>>): string[] =>
          harness.runner.calls
            .filter((call) => call.command === binaries.adb && call.args[0] === "-s")
            .map((call) => call.args.slice(2).join(" "));
        const saveLaunch = (harness: Awaited<ReturnType<typeof seedHarness>>) =>
          harness.runner.calls
            .filter((call) => call.args.includes("-avd"))
            .map((call) => [call.options.env?.["ANDROID_AVD_HOME"], call.args.at(-1)]);

        const powered = await seedHarness([...leasing(true), ...savingSteps, ...sourceBoot()], {
          config,
          ids,
        });
        const poweredReady = await powered.driver.makeReady(
          await powered.driver.provision(powered.spec),
        );
        const poweredSaved = await powered.driver.saveSource({
          ...poweredReady,
          physical: false as const,
        });
        expect(poweredSaved).toEqual({
          imageTag: "google_apis",
          sizeBytes: 121,
          sourceId: "baseline_four",
        });
        await kept(powered);
        expect(sent(powered)).toEqual(
          expect.arrayContaining([
            "shell sync",
            "shell reboot -p",
            "emu avd snapshot save simlock_boot",
          ]),
        );
        expect(sent(powered).indexOf("shell reboot -p")).toBeLessThan(
          sent(powered).lastIndexOf("emu avd snapshot save simlock_boot"),
        );
        expect(saveLaunch(powered).at(-1)).toEqual([savedHome, "-no-snapshot-load"]);

        const clock = new FakeClock();
        const stuck = await seedHarness(
          [
            ...leasing(true),
            ...savingSteps,
            processResult(
              binaries.adb,
              ["-s", serial, "emu", "avd", "path"],
              `${copyHome}/simlock.avd\r\nOK\r\n`,
            ),
            processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
            ...sourceBoot(),
          ],
          { clock, config, ids },
        );
        const stuckReady = await stuck.driver.makeReady(await stuck.driver.provision(stuck.spec));
        // why: the stuck emulator ignores `reboot -p` and `emu kill`; only the deadlines and a SIGKILL end it.
        stuck.runner.ignoresEmuKill = true;
        const stuckSaving = stuck.driver.saveSource({ ...stuckReady, physical: false as const });
        await vi.waitFor(() =>
          expect(stuck.runner.calls.filter((call) => call.args.includes("reboot"))).toHaveLength(2),
        );
        clock.advance(60_000);
        await vi.waitFor(() =>
          expect(stuck.runner.calls.filter((call) => call.args.includes("kill"))).toHaveLength(2),
        );
        stuck.runner.ignoresEmuKill = false;
        let stuckDone = false;
        void stuckSaving.then(
          () => (stuckDone = true),
          () => (stuckDone = true),
        );
        await vi.waitFor(() => {
          clock.advance(60_000);
          expect(stuckDone).toBe(true);
        });
        await expect(stuckSaving).resolves.toMatchObject({ sourceId: "baseline_four" });
        await kept(stuck);
        expect(sent(stuck).slice(sent(stuck).indexOf("shell reboot -p"))).toEqual(
          expect.arrayContaining(["emu avd path", "emu kill"]),
        );

        const restarted = await seedHarness(leasing(true), { config, ids });
        const restartedReady = await restarted.driver.makeReady(
          await restarted.driver.provision(restarted.spec),
        );
        const clockAfter = new FakeClock();
        const adopted = await reopened(
          restarted,
          [
            ...savingSteps,
            processResult(
              binaries.adb,
              ["devices"],
              `List of devices attached\n${serial}\tdevice\n`,
            ),
            processResult(binaries.adb, ["devices"], "List of devices attached\n"),
            ...sourceBoot(),
          ],
          { clock: clockAfter },
        );
        const adoptedSaving = adopted.driver.saveSource({
          ...restartedReady,
          physical: false as const,
        });
        await vi.waitFor(() =>
          expect(adopted.runner.calls.filter((call) => call.args[0] === "devices")).toHaveLength(1),
        );
        clockAfter.advance(1_000);
        await expect(adoptedSaving).resolves.toMatchObject({ sourceId: "baseline_four" });
        await kept({ ...restarted, driver: adopted.driver });
      });

      it("saves a device whose config.ini has spaces around `=`, as avdmanager writes it, with the model and image it names", async () => {
        const spaced =
          "hw.device.name = pixel_6\nimage.sysdir.1 = system-images/android-34/google_apis/arm64-v8a/\nhw.ramSize = 2048\n";
        const harness = await seedHarness([...leasing(true), ...savingSteps, ...sourceBoot()], {
          config: spaced,
          ids,
        });
        const ready = await harness.driver.makeReady(await harness.driver.provision(harness.spec));

        await expect(
          harness.driver.saveSource({ ...ready, physical: false as const }),
        ).resolves.toMatchObject({ imageTag: "google_apis", sourceId: "baseline_four" });

        expect(
          (await harness.driver.listSources()).find((source) => source.id === "baseline_four"),
        ).toMatchObject({
          imageTag: "google_apis",
          kind: "baseline",
          model: "pixel_6",
          osVersion: "34",
        });
      });
    });

    describe("saveSource failures", () => {
      const savedHome = `${sources}/baseline_four`;
      const serial = "emulator-5586";
      const config =
        "hw.device.name=pixel_5\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\nhw.ramSize=2048\n";
      const version = processResult(
        binaries.emulator,
        ["-version"],
        "Android emulator version 36.1.9",
      );
      const probe = (path = `${copyHome}/simlock.avd`) =>
        processResult(binaries.adb, ["-s", serial, "emu", "avd", "path"], `${path}\r\nOK\r\n`);
      const poweredOff = [
        version,
        probe(),
        processResult(binaries.adb, ["-s", serial, "shell", "sync"]),
        processResult(binaries.adb, ["-s", serial, "shell", "reboot", "-p"]),
      ];
      const stage = seedStages(savedHome);

      it("deletes the source's folder and row and throws when the ownership check fails, the copy fails or the boot snapshot is not saved, leaving the device as it was", async () => {
        const cases = [
          {
            expectations: [version, probe(`${avdDirectory}/other.avd`)],
            message: "emulator-5586 is not its emulator",
            sent: false,
          },
          {
            copyFails: true,
            expectations: poweredOff,
            message: "copying Android device simlock_one to source baseline_four failed: no space",
          },
          {
            expectations: [
              ...poweredOff,
              stage.devices,
              ...stage.secondBoot,
              { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
            ],
            message: "Android seed baseline_four: boot snapshot simlock_boot was not saved",
          },
        ] as const;

        for (const failing of cases) {
          const filesystem = new ArmedCopyFailureFilesystem("no space");
          const harness = await seedHarness(
            [
              ...makingTheSeed(),
              processResult(binaries.adb, ["devices"], "List of devices attached\n"),
              ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true),
              markWriteExpectation(serial, "three"),
              ...failing.expectations,
            ],
            { config, filesystem, ids: ["one", "two", "three", "four"] },
          );
          const ready = await harness.driver.makeReady(
            await harness.driver.provision(harness.spec),
          );
          filesystem.armed = "copyFails" in failing;
          const before = harness.runner.calls.length;

          await expect(
            harness.driver.saveSource({ ...ready, physical: false as const }),
          ).rejects.toThrow(failing.message);

          const sentToDevice = harness.runner.calls
            .slice(before)
            .filter((call) => call.args.includes("sync") || call.args.includes("reboot"));
          expect(sentToDevice.length > 0, failing.message).toBe(!("sent" in failing));
          expect(await harness.filesystem.exists(savedHome), failing.message).toBe(false);
          expect(await harness.filesystem.exists(copyHome), failing.message).toBe(true);
          expect(
            harness.database
              .prepare("SELECT source_id FROM android_source_data WHERE kind = 'baseline'")
              .all(),
            failing.message,
          ).toEqual([]);
          const emulators = harness.runner.calls.flatMap((call, index) =>
            call.args.includes("-avd") ? [index] : [],
          );
          // why: the first two launches make the seed and the third is the device's own, which a failure before `reboot -p` leaves running; what follows is the source's boot.
          for (const emulator of emulators.slice(3)) {
            let exited = false;
            void harness.runner.handles[emulator]?.wait().then(() => {
              exited = true;
            });
            await vi.waitFor(() => expect(exited, "the source's emulator was stopped").toBe(true));
          }
        }
      });
    });

    it("quotes a provision at 1 s with a fresh seed and 150 s without one, and a prepare boot at 4 s for a copy and 70 s otherwise", async () => {
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      const spec = { ...harness.spec, physical: false } as const;
      const provision = { operation: "provision" } as const;
      expect(harness.driver.estimate(provision, spec)).toBe(150_000);

      const copy = await harness.driver.provision(harness.spec);

      expect(harness.driver.estimate(provision, spec)).toBe(1_000);
      expect(harness.driver.estimate(provision, { ...spec, model: "Pixel 9" })).toBe(150_000);
      expect(harness.driver.estimate(provision, { ...spec, imageTag: "android-tv" })).toBe(150_000);
      const prepare = { device: copy, operation: "boot", purpose: "prepare" } as const;
      const oldLayout = {
        address: "",
        deviceId: "simlock_old",
        driverData: { avdName: "simlock_old", configHash: "hash", port: 0, serial: "" },
      };
      expect(
        await Promise.all([
          harness.driver.estimate(prepare, spec),
          harness.driver.estimate({ ...prepare, purpose: "recover" }, spec),
          harness.driver.estimate({ ...prepare, device: oldLayout }, spec),
        ]),
      ).toEqual([4_000, 70_000, 70_000]);
      await expect(
        harness.driver.estimate({ ...prepare, device: { ...copy, deviceId: "other" } }, spec),
        "a device id that does not match its AVD rejects the returned promise: a throw would skip the caller's fallback",
      ).rejects.toThrow("does not match AVD");

      const staled = await reopened(harness, [
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.2.0"),
      ]);
      await staled.driver.listSources();
      expect(staled.driver.estimate(provision, spec)).toBe(150_000);
    });

    it("destroys the seeds made from a system image when it is removed, and a seed it cannot destroy stays listed as stale", async () => {
      const packageName = "system-images;android-34;google_apis;arm64-v8a";
      const imagePath = `${sdk}/system-images/android-34/google_apis/arm64-v8a`;
      const uninstall = processResult(binaries.sdkmanager, ["--uninstall", packageName]);
      const noEmulators = processResult(binaries.adb, ["devices"], "List of devices attached\n");
      const remove = async (
        harness: Awaited<ReturnType<typeof seedHarness>>,
        failingFolder?: string,
        alsoMake?: { readonly home: string; readonly imageTag: string },
      ) => {
        await harness.driver.provision(harness.spec);
        if (alsoMake !== undefined) {
          await harness.filesystem.mkdirp(
            `${sdk}/system-images/android-34/${alsoMake.imageTag}/arm64-v8a`,
          );
          await writeSeedFiles(harness.filesystem, alsoMake.home);
          await harness.driver.provision(
            await harness.driver.resolveSpec({
              imageTag: alsoMake.imageTag,
              model: "Pixel 5",
              osVersion: "34",
              platform: "android",
            }),
          );
        }
        if (failingFolder !== undefined) harness.filesystem.defineFailure(failingFolder, "EACCES");
        const target = (await harness.driver.listComponents()).find(
          (component) => component.variant === "google_apis/arm64-v8a",
        );
        // why: the scripted runner only answers; real sdkmanager also deletes the image's folder.
        const spawn = harness.runner.spawn.bind(harness.runner);
        vi.spyOn(harness.runner, "spawn").mockImplementation((command, args, options) => {
          if (args[0] === "--uninstall") void harness.filesystem.rm(imagePath);
          return spawn(command, args, options);
        });
        await harness.driver.removeComponent(target?.receipt ?? {}, {
          signal: new AbortController().signal,
        });
      };

      const destroyed = await seedHarness([...makingTheSeed(), uninstall, noEmulators]);
      await remove(destroyed);
      expect(await destroyed.filesystem.exists(seedHome)).toBe(false);
      await expect(destroyed.driver.listSources()).resolves.toEqual([]);

      const otherHome = `${sources}/seed_device-4`;
      const other = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        ...makingASeedFrom(otherHome),
        uninstall,
        noEmulators,
      ]);
      await remove(other, undefined, { home: otherHome, imageTag: "google_apis_playstore" });
      expect(await other.filesystem.exists(seedHome)).toBe(false);
      expect(await other.filesystem.exists(otherHome)).toBe(true);

      const stuck = await seedHarness([
        ...makingTheSeed(),
        uninstall,
        noEmulators,
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await remove(stuck, seedHome);
      await expect(stuck.driver.listSources()).resolves.toMatchObject([
        { id: "seed_two", staleReason: `system image ${packageName} is not installed` },
      ]);
    });

    it("boots a recovered copy cold from its disk on its recorded port: no snapshot is loaded and nothing is wiped, a second makeReady does not boot again and destroy stops it", async () => {
      const harness = await seedHarness([
        ...bootingAt(copyHome, ["-no-snapshot-load"], true),
        markWriteExpectation("emulator-5586", "one"),
        ...bootingAt(copyHome, [], true).slice(1),
        markWriteExpectation("emulator-5586", "two"),
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ]);
      await writeSeedFiles(harness.filesystem, copyHome);

      const recovered = {
        address: "emulator-5586",
        deviceId: "simlock_one",
        driverData: {
          avdHome: copyHome,
          avdName: "simlock",
          configHash: "hash",
          port: 5586,
          serial: "emulator-5586",
        },
      };
      await harness.driver.makeReady(recovered, { purpose: "recover" });

      const launch = harness.runner.calls.find((call) => call.args.includes("-avd"));
      expect(launch?.args).toContain("-no-snapshot-load");
      expect(launch?.args).not.toContain("-snapshot");
      expect(launch?.args).not.toContain("-wipe-data");
      expect(launch?.options.env).toMatchObject({ ANDROID_AVD_HOME: copyHome });

      await harness.driver.makeReady(recovered);
      await harness.driver.destroy(recovered);
      expect(emulatorLaunchArgs(harness.runner)).toHaveLength(1);
      expect(
        harness.runner.calls.some((call) => call.args.slice(-2).join(" ") === "emu kill"),
        "destroy stops the emulator the recover boot started",
      ).toBe(true);
    });

    it("boots a device made before copies once with a wipe: a second makeReady does not boot again and destroy stops it and deletes it through avdmanager", async () => {
      const serial = "emulator-5586";
      const polls = (name: string) => [
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          "1\n",
        ),
        processResult(binaries.adb, ["-s", serial, "shell", "getprop", "init.svc.bootanim"], ""),
        avdPathExpectation(serial, name),
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "pm", "path", "android"],
          "package:/system/framework/framework-res.apk\n",
        ),
      ];
      const harness = await seedHarness([
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        {
          hangs: true,
          match: {
            args: ["-avd", "simlock_old", ...seedEmulatorLine, "-wipe-data", "-no-snapshot-load"],
            command: binaries.emulator,
          },
        },
        ...polls("simlock_old"),
        markWriteExpectation(serial, "one"),
        ...polls("simlock_old"),
        markWriteExpectation(serial, "two"),
        avdPathExpectation(serial, "simlock_old"),
        processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
        processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
      ]);
      await harness.filesystem.mkdirp(`${avdDirectory}/simlock_old.avd`);
      await harness.filesystem.writeFileAtomic(
        `${avdDirectory}/simlock_old.avd/config.ini`,
        "hw.ramSize=2048\n",
      );
      const legacy = {
        address: "",
        deviceId: "simlock_old",
        driverData: { avdName: "simlock_old", configHash: "hash", port: 0, serial: "" },
      };

      await harness.driver.makeReady(legacy);
      expect(emulatorLaunchArgs(harness.runner)[0]).toEqual(
        expect.arrayContaining(["-wipe-data", "-no-snapshot-load"]),
      );
      await harness.driver.makeReady(legacy);
      await harness.driver.destroy(legacy);

      expect(emulatorLaunchArgs(harness.runner), "the wipe boot happens once").toHaveLength(1);
      expect(
        harness.runner.calls.some((call) => call.args.slice(-2).join(" ") === "emu kill"),
        "destroy stops the emulator the wipe boot started",
      ).toBe(true);
      expect(
        harness.runner.calls.some(
          (call) =>
            call.command === binaries.avdmanager &&
            call.args.join(" ") === "delete avd -n simlock_old",
        ),
        "destroy deletes the device through avdmanager",
      ).toBe(true);
    });

    it("destroys a plain Android device after its ownership check: the emulator is killed and its folder deleted, an unreadable check or a failing delete throws and keeps it, and a folder outside the root is never deleted", async () => {
      const serial = "emulator-5586";
      const attached = `List of devices attached\n${serial}\tdevice\n`;
      const own = {
        address: serial,
        deviceId: "simlock_one",
        driverData: {
          avdHome: copyHome,
          avdName: "simlock",
          configHash: "hash",
          port: 5586,
          serial,
        },
      };
      const harness = async (expectations: readonly ScriptedProcessExpectation[]) => {
        const filesystem = await androidFilesystem();
        for (const home of [copyHome, `${avdDirectory}/simlock_two`]) {
          await filesystem.mkdirp(`${home}/simlock.avd`);
          await filesystem.writeFileAtomic(`${home}/simlock.avd/config.ini`, "hw.ramSize=2048\n");
        }
        const runner = new EmulatorExitingRunner([...expectations]);
        return { driver: await createDriver(filesystem, runner), filesystem, runner };
      };
      const answersWith = (folder: string) =>
        processResult(
          binaries.adb,
          ["-s", serial, "emu", "avd", "path"],
          `${folder}/simlock.avd\r\nOK\r\n`,
        );

      const passes = await harness([
        processResult(binaries.adb, ["devices"], attached),
        answersWith(copyHome),
        processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      await passes.driver.destroy(own);
      expect(await passes.filesystem.exists(copyHome)).toBe(false);
      expect(await passes.filesystem.exists(`${avdDirectory}/simlock_two`)).toBe(true);

      const neighbour = await harness([
        processResult(
          binaries.adb,
          ["devices"],
          "List of devices attached\nemulator-5588\tdevice\n",
        ),
        processResult(
          binaries.adb,
          ["-s", "emulator-5588", "emu", "avd", "path"],
          `${avdDirectory}/simlock_two/simlock.avd\r\nOK\r\n`,
        ),
      ]);
      await neighbour.driver.destroy(own);
      expect(await neighbour.filesystem.exists(copyHome)).toBe(false);
      expect(neighbour.runner.calls.flatMap((call) => call.args)).not.toContain("kill");

      const unreadable = await harness([
        processResult(binaries.adb, ["devices"], attached),
        {
          match: { args: ["-s", serial, "emu", "avd", "path"], command: binaries.adb },
          result: { code: 1, stderr: "error", stdout: "" },
        },
      ]);
      await expect(unreadable.driver.destroy(own)).rejects.toThrow(
        `Refusing to delete simlock_one: could not tell which AVD the emulator on ${serial} runs`,
      );
      expect(await unreadable.filesystem.exists(copyHome)).toBe(true);
      expect(unreadable.runner.calls.flatMap((call) => call.args)).not.toContain("kill");

      const failingDelete = await harness([
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      failingDelete.filesystem.defineFailure(copyHome, "EACCES");
      await expect(failingDelete.driver.destroy(own)).rejects.toMatchObject({ code: "EACCES" });
      expect(await failingDelete.filesystem.exists(`${avdDirectory}/simlock_two`)).toBe(true);

      const outside = await harness([]);
      await outside.filesystem.mkdirp("/elsewhere/simlock_two");
      await expect(
        outside.driver.destroy({
          ...own,
          deviceId: "simlock_two",
          driverData: { ...own.driverData, avdHome: "/elsewhere/simlock_two" },
        }),
      ).rejects.toThrow("Android device simlock_two names a folder outside the root");
      expect(await outside.filesystem.exists("/elsewhere/simlock_two")).toBe(true);
      expect(await outside.filesystem.exists(`${avdDirectory}/simlock_two`)).toBe(true);

      const malformed = await harness([]);
      await expect(
        malformed.driver.destroy({
          ...own,
          driverData: { ...own.driverData, avdHome: 5 },
        }),
      ).rejects.toThrow("Android device simlock_one has invalid driver data");
      expect(await malformed.filesystem.exists(copyHome)).toBe(true);

      const old = await harness([
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
      ]);
      await old.driver.destroy({
        ...own,
        deviceId: "simlock_old",
        driverData: { avdName: "simlock_old", configHash: "hash", port: 0, serial: "" },
      });
      expect(old.runner.calls[1]?.options.env).toMatchObject({ ANDROID_AVD_HOME: avdDirectory });

      await expect(old.driver.reclaim(own, { clean: "standard" })).rejects.toMatchObject({
        message: "virtual devices are not reclaimed",
        name: "DriverCrashError",
      });
    });
  });
});

/** why: copies work until a test arms the failure, so a device can be provisioned from a seed first. */
class ArmedCopyFailureFilesystem extends MemoryFilesystem {
  armed = false;

  constructor(private readonly message: string) {
    super();
  }

  override copyTree(
    from: string,
    to: string,
    options: { readonly timeoutMs: number },
  ): Promise<void> {
    return this.armed ? Promise.reject(new Error(this.message)) : super.copyTree(from, to, options);
  }
}

/** why: tells a test what is running when a path is removed, so "stopped before deleted" is observed, not assumed. */
class RemovalObservingFilesystem extends MemoryFilesystem {
  onRemove: (path: string) => void = () => undefined;

  override async rm(path: string): Promise<void> {
    this.onRemove(path);
    await super.rm(path);
  }
}

/** why: what a running AVD made before copies answers to `emu avd path`: `<root>/<name>.avd`. */
function avdPathExpectation(serial: string, avdName = "simlock_one"): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${avdName}.avd\r\nOK\r\n`,
  );
}

/**
 * why: An `EmulatorHost` on which another emulator takes a device's console port just before the
 * device's own emulator is spawned on it, and which answers the queries that tell emulators
 * apart: `emu avd path`, `emu avd name` and `getprop ro.boot.qemu.avd_name`.
 *
 * The device's emulator cannot bind the taken port and exits -- but not before the other
 * emulator has answered the readiness poll, as it does on a real machine, where the other
 * emulator answers at once and the spawned one checks its ports only once it has started.
 * So in this fake its exit is seen only once it is killed: a driver that waited for that
 * exit would already have readied the device.
 */
class PortTakingMachine {
  readonly #inner: ProcessRunner;
  readonly #otherPaths = new Map<number, string>();
  #takeOnNextBoot: ((port: number) => void) | undefined;

  constructor(private readonly host: EmulatorHost) {
    this.#inner = host.runner();
  }

  avdPathAnswering(serial: string | undefined): string | undefined {
    const path = this.host.pathAnswering(serial);
    if (path === undefined) return undefined;
    return this.#otherPaths.get(consolePortOf(serial)) ?? path;
  }

  takePortOnNextBoot(avdPath: string): {
    observed(): { running: boolean; sentByDriver: string[] };
  } {
    let running = false;
    let port = Number.NaN;
    const sent: string[] = [];
    this.#takeOnNextBoot = (taken) => {
      port = taken;
      const avdName = /([^/]+)\.avd$/.exec(avdPath)?.[1] ?? "";
      const handle = this.#inner.spawn(
        binaries.emulator,
        ["-avd", avdName, "-port", String(taken)],
        emulatorOptions,
      );
      running = true;
      void handle.wait().then(() => {
        running = false;
      });
      this.#otherPaths.set(taken, avdPath);
    };
    this.#sentTo = (serial, command) => {
      if (consolePortOf(serial) === port && running && !QUERIES.test(command)) sent.push(command);
    };
    return { observed: () => ({ running, sentByDriver: sent }) };
  }

  #sentTo: (serial: string, command: string) => void = () => undefined;

  runner(): ProcessRunner {
    return {
      run: async (command, args, options) => {
        if (command === binaries.adb && args[0] === "-s") {
          const serial = args[1] ?? "";
          const rest = args.slice(2).join(" ");
          this.#sentTo(serial, rest);
          const answer = this.#identity(serial, rest);
          if (answer !== undefined) return answer;
        }
        return this.#inner.run(command, args, options);
      },
      spawn: (command, args, options) => {
        const take = this.#takeOnNextBoot;
        if (take === undefined || command !== binaries.emulator) {
          return this.#inner.spawn(command, args, options);
        }
        this.#takeOnNextBoot = undefined;
        take(Number(args[args.indexOf("-port") + 1]));
        const handle = this.#inner.spawn(command, args, options);
        let killed!: () => void;
        const exitSeen = new Promise<void>((resolve) => {
          killed = resolve;
        });
        return {
          ...handle,
          kill: (signal) => {
            handle.kill(signal);
            killed();
          },
          wait: async () => {
            await exitSeen;
            return handle.wait();
          },
        };
      },
      spawnStreaming: (command, args, options) =>
        this.#inner.spawnStreaming(command, args, options),
    };
  }

  #identity(serial: string, command: string): ProcessResult | undefined {
    const path = this.avdPathAnswering(serial);
    if (path === undefined) return undefined;
    const name = /([^/]+)\.avd$/.exec(path)?.[1] ?? "";
    if (command === "emu avd path") return ok(`${path}\nOK\n`);
    if (command === "emu avd name") return ok(`${name}\nOK\n`);
    if (command === "shell getprop ro.boot.qemu.avd_name") return ok(`${name}\n`);
    return undefined;
  }
}

/** why: `emu avd path` answers truthfully until the test sets an answer, so a seed is made first and only the copy's boot is lied to. */
function overridingAvdPath(inner: ProcessRunner): {
  readonly answer: (answer: ProcessResult) => void;
  readonly runner: ProcessRunner;
} {
  let answer: ProcessResult | undefined;
  return {
    answer: (next) => {
      answer = next;
    },
    runner: {
      run: async (command, args, options) =>
        answer !== undefined &&
        command === binaries.adb &&
        args[0] === "-s" &&
        args.slice(2).join(" ") === "emu avd path"
          ? answer
          : inner.run(command, args, options),
      spawn: (command, args, options) => inner.spawn(command, args, options),
      spawnStreaming: (command, args, options) => inner.spawnStreaming(command, args, options),
    },
  };
}

class LinkedHomeFilesystem extends MemoryFilesystem {
  override async realpath(path: string): Promise<string> {
    const resolved = await super.realpath(path.replace(/^\/private\/home\//, "/home/"));
    return resolved.replace(/^\/home\//, "/private/home/");
  }
}

const QUERIES = /^(shell getprop \S+|emu avd (name|path|id|status|discoverypath))$/;

/**
 * why: The message of the driver's `DriverCrashError`; anything else -- a boot timeout, the fake's
 * own complaint about an unscripted call -- is rethrown, so it fails the test as itself.
 */
function driverCrashMessage(error: unknown): { readonly refused: string } {
  if (error instanceof Error && error.name === "DriverCrashError") {
    return { refused: error.message };
  }
  throw error;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
