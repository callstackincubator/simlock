import { describe, expect, it, vi } from "vitest";
import { DeviceTcpError } from "../../core/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  FakeClock,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  type ScriptedProcessExpectation,
  type TcpStream,
} from "../../ports/index.js";
import {
  androidFilesystem,
  binaries,
  EmulatorExitingRunner,
  processResult,
  scopedEnv,
  PHYSICAL_DEVICE,
  provisionedHarness,
  createDriver,
  copyPathExpectation,
} from "./testing.js";
import { avdPathExpectation } from "./test-index-lifecycle.js";

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
