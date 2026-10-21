import { describe, expect, it } from "vitest";

import {
  type PhysicalDriverDevice,
  SCREEN_FRAME_TAG,
  ScreenUnavailableError,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  type ProcessResult,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
  type TcpStream,
} from "../../../ports/index.js";
import {
  ALIVE_AFTER_MS,
  CLOSE_DEADLINE_MS,
  CONNECT_RETRY_MS,
  createAndroidScreenCapture,
  type ScreenTarget,
  START_DEADLINE_MS,
} from "./session.js";
import { codecId, concatBytes, mediaPacket, SAMPLE, sessionPacket } from "./test-scrcpy.js";

const ADB = "/sdk/platform-tools/adb";
const SERVER = "/simlock/scrcpy-server-v5.0.1";
const SERIAL = "emulator-5586";
const PHONE_SERIAL = "R58M123ABC";
const SCID = 0x1234abcd;
const DEVICE_JAR = "/data/local/tmp/simlock-scrcpy-1234abcd.jar";
const SETTINGS = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };
const SCREEN_READ_MS = 10_000;
const WAKE_MS = 10_000;
const DEVICE: VirtualDriverDevice = {
  address: SERIAL,
  deviceId: "simlock_1",
  driverData: {},
  physical: false,
};
const PHONE: PhysicalDriverDevice = {
  address: PHONE_SERIAL,
  deviceId: PHONE_SERIAL,
  driverData: {},
  enrolledApps: [],
  physical: true,
};

// why: the reason a phone's target gives when the shared adb server's version check is closed. The
// capture is expected to pass it through as its own, unchanged, and to run nothing after it.
const GATE_REFUSAL =
  "the adb server on port 5037 speaks protocol 40 and Simlock's adb speaks 41. " +
  "No command goes to physical Android devices until they match, and Simlock will not restart that server.";
const SCREEN_OFF =
  "The phone's screen is off and did not turn on. Turn it on and ask for the stream again.";
const WAKE_ARGS = "shell input keyevent KEYCODE_WAKEUP";

type Behaviour = "accept" | "refuse" | "no-transport" | "connection-refused" | "silent";

class Peer {
  readonly written: string[] = [];
  closed = false;
  pulls = 0;
  readonly #queue: Uint8Array[] = [];
  #wake: (() => void) | undefined;
  readonly stream: TcpStream;

  constructor() {
    const readable = new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          this.close();
        },
        pull: async (controller) => {
          this.pulls += 1;
          while (this.#queue.length === 0 && !this.closed) {
            await new Promise<void>((resolve) => {
              this.#wake = resolve;
            });
          }
          const next = this.#queue.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(next);
        },
      },
      { highWaterMark: 0 },
    );
    this.stream = {
      close: () => {
        this.close();
      },
      readable,
      write: async (bytes) => {
        this.written.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
      },
    };
  }

  send(...chunks: (Uint8Array | string)[]): void {
    for (const chunk of chunks) {
      this.#queue.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    this.#wake?.();
  }

  close(): void {
    this.closed = true;
    this.#wake?.();
  }
}

// why: the adb server on the far side of a target's `connect`; what it answers is scripted per attempt.
class AdbServer {
  readonly peers: Peer[] = [];
  readonly #behaviours: Behaviour[];

  constructor(
    behaviours: Behaviour[] = [],
    readonly otherwise: Behaviour = "accept",
    // why: a peer that stays silent and open until this moment of the fake clock, then refuses.
    private readonly acceptFromMs: number | undefined = undefined,
  ) {
    this.#behaviours = behaviours;
  }

  newPeer(clock: FakeClock): Peer | undefined {
    if (this.acceptFromMs !== undefined && clock.now() < this.acceptFromMs) {
      const waiting = new Peer();
      waiting.send("OKAY", "FAIL0006closed");
      return waiting;
    }
    const behaviour = this.#behaviours.shift() ?? this.otherwise;
    if (behaviour === "connection-refused") throw new Error("connect ECONNREFUSED 127.0.0.1");
    const peer = new Peer();
    this.peers.push(peer);
    if (behaviour === "no-transport") peer.send(`FAIL0020device '${SERIAL}' not found`);
    if (behaviour === "refuse") peer.send("OKAY", "FAIL0006closed");
    if (behaviour === "accept") peer.send("OKAY", "OKAY", new Uint8Array([0]));
    return peer;
  }

  get last(): Peer {
    const peer = this.peers.at(-1);
    if (peer === undefined) throw new Error("no connection");
    return peer;
  }
}

interface PowerAnswer {
  readonly code: number | null;
  readonly stdout: string;
}

// why: the device's capture target as the driver builds it. `args` start at the adb subcommand, so
// the serial and the adb server are the target's and not the capture's: this fake records what it
// was asked to run, and the commands themselves are the scripted runner's, so a push can fail, a
// server can hang and a kill can be escalated exactly as before the target existed.
class FakeTarget implements ScreenTarget {
  readonly log: string[] = [];
  readonly powerReads: number[] = [];
  readonly wakes: number[] = [];
  // why: the order of the screen steps, so "reads again after the wake" can fail.
  readonly screenSteps: string[] = [];
  readonly connects: number[] = [];
  readonly runner: ScriptedProcessRunner;
  readonly server: AdbServer;
  // why: `"refuse"` is the version check refusing the read, `"slow"` a read that ends later.
  // why: a list answers the reads in turn, the last one for every read after it.
  power: PowerAnswer | "refuse" | "slow" | readonly (PowerAnswer | "refuse" | "slow")[] = {
    code: 0,
    stdout: "  mWakefulness=Awake\n",
  };
  // why: what the wake does: exits 0, exits non-zero, hangs to its limit, or is refused by the check.
  wake: "ok" | "fail" | "slow" | "refuse" = "ok";
  // why: holds each screen read the check lets through in flight for the read limit before it answers as scripted (a refused read throws before the hold), so a stop can arrive while a read that will say Asleep is still running.
  holdReads = false;
  // why: stands in for a check that closes mid-session: a command whose args this picks out is refused as a closed check refuses it.
  refuses: (args: readonly string[]) => boolean = () => false;
  // why: stand-ins for the check a target runs before its own command or connection, so a bound can be measured against it.
  spawnDelayMs = 0;
  connectDelayMs = 0;
  #clock: FakeClock;

  constructor(
    readonly serial: string,
    clock: FakeClock,
    expectations: ScriptedProcessExpectation[],
    server: AdbServer | undefined,
  ) {
    this.#clock = clock;
    this.runner = new ScriptedProcessRunner(expectations);
    this.server = server ?? new AdbServer();
  }

  get steps(): string[] {
    return this.log.map((entry) => (entry.includes("app_process") ? "server" : entry));
  }

  async run(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    if (isScreenRead(args)) return await this.#readScreen(timeoutMs);
    if (args.join(" ") === WAKE_ARGS) {
      this.wakes.push(timeoutMs);
      this.screenSteps.push("wake");
      if (this.wake === "refuse") throw new ScreenUnavailableError(GATE_REFUSAL);
      if (this.wake === "slow") {
        await this.#sleep(WAKE_MS);
        return { code: null, stderr: "", stdout: "" };
      }
      return { code: this.wake === "fail" ? 1 : 0, stderr: "", stdout: "" };
    }
    if (this.refuses(args)) throw new ScreenUnavailableError(GATE_REFUSAL);
    this.log.push(args.join(" "));
    return await this.runner.run(ADB, args);
  }

  async spawn(args: readonly string[]): Promise<import("../../../ports/index.js").ProcessHandle> {
    if (this.spawnDelayMs > 0) await this.#sleep(this.spawnDelayMs);
    if (this.refuses(args)) throw new ScreenUnavailableError(GATE_REFUSAL);
    this.log.push(args.join(" "));
    return await this.runner.spawn(ADB, args);
  }

  async connect(timeoutMs: number): Promise<TcpStream> {
    this.connects.push(timeoutMs);
    if (this.refuses(["connect"])) throw new ScreenUnavailableError(GATE_REFUSAL);
    if (this.connectDelayMs > 0) await this.#sleep(this.connectDelayMs);
    const peer = this.server.newPeer(this.#clock);
    if (peer === undefined) throw new Error("connect ECONNREFUSED 127.0.0.1");
    return peer.stream;
  }

  async #readScreen(timeoutMs: number): Promise<ProcessResult> {
    const answer = Array.isArray(this.power)
      ? (this.power[Math.min(this.powerReads.length, this.power.length - 1)] as PowerAnswer)
      : (this.power as PowerAnswer | "refuse" | "slow");
    this.powerReads.push(timeoutMs);
    this.screenSteps.push("read");
    if (answer === "refuse") throw new ScreenUnavailableError(GATE_REFUSAL);
    if (this.holdReads || answer === "slow") await this.#sleep(SCREEN_READ_MS);
    if (answer === "slow") return { code: null, stderr: "", stdout: "" };
    return { code: answer.code, stderr: "", stdout: answer.stdout };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#clock.setTimer(ms, resolve);
    });
  }
}

function isScreenRead(args: readonly string[]): boolean {
  return args.join(" ") === "shell dumpsys power";
}

function push(result: Partial<{ code: number; stderr: string }> = {}): ScriptedProcessExpectation {
  return {
    match: {
      args: ["push", SERVER, /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
    result: { code: result.code ?? 0, stderr: result.stderr ?? "", stdout: "" },
  };
}

// why: a phone's server command carries one more option (stay_awake) than an emulator's 20 arguments.
function shell(
  extra: Partial<ScriptedProcessExpectation> = {},
  options = 20,
): ScriptedProcessExpectation {
  return {
    hangs: true,
    match: {
      args: ["shell", ...Array.from({ length: options }, () => /.*/)],
      command: ADB,
    },
    ...extra,
  };
}

function remove(): ScriptedProcessExpectation {
  return {
    match: {
      args: ["shell", "rm", "-f", /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
  };
}

// why: both devices' worlds — the other device's target is here so "it went through this device's
// target" can fail; a capture that aimed at the wrong device would show up in the other's lists.
async function setup(
  options: {
    readonly acceptFromMs?: number;
    readonly device?: VirtualDriverDevice | PhysicalDriverDevice;
    readonly expectations?: ScriptedProcessExpectation[];
    readonly jar?: boolean;
    readonly power?: FakeTarget["power"];
    readonly wake?: FakeTarget["wake"];
    readonly refuses?: (args: readonly string[]) => boolean;
    readonly scid?: (() => number) | null;
    readonly server?: AdbServer;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  if (options.jar !== false) {
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(SERVER, "jar");
  }
  const device = options.device ?? DEVICE;
  const phone = device.physical === true;
  const server =
    options.server ??
    new AdbServer(
      [],
      "accept",
      options.acceptFromMs === undefined ? undefined : 1_000 + options.acceptFromMs,
    );
  const target = new FakeTarget(
    phone ? PHONE_SERIAL : SERIAL,
    clock,
    options.expectations ?? [push(), shell({}, phone ? 21 : 20), remove()],
    server,
  );
  const scripted = { power: options.power, refuses: options.refuses, wake: options.wake };
  Object.assign(
    target,
    Object.fromEntries(Object.entries(scripted).filter(([, value]) => value !== undefined)),
  );
  const other = new FakeTarget(phone ? SERIAL : PHONE_SERIAL, clock, [], new AdbServer());
  const capture = createAndroidScreenCapture({
    clock,
    filesystem,
    ...(options.scid === null ? {} : { scid: options.scid ?? (() => SCID) }),
    serverPath: SERVER,
    targetFor: async (asked) => (asked === device ? target : other),
  });
  return { capture, clock, other, target };
}

async function drive<T>(clock: FakeClock, promise: Promise<T>, stepMs = 50): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let spent = 0; spent <= 120_000; spent += stepMs) {
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    if (settled) return await promise;
    clock.advance(stepMs);
  }
  throw new Error("did not settle within two fake minutes");
}

function streamStart(): Uint8Array {
  return concatBytes(codecId(), sessionPacket(96, 64));
}

async function hasEnded(handle: { wait(): Promise<unknown> }): Promise<boolean> {
  let ended = false;
  void handle.wait().then(() => (ended = true));
  for (let flush = 0; flush < 5; flush += 1) await new Promise((resolve) => setImmediate(resolve));
  return ended;
}

function frameTag(frame: Uint8Array | undefined): number | undefined {
  return frame?.[4];
}

async function waitThenStart<T>(target: FakeTarget, opening: Promise<T>): Promise<T> {
  for (let tries = 0; tries < 100 && target.server.peers.length === 0; tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  target.server.last.send(streamStart());
  return await opening;
}

async function opened(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { capture, clock, target } = setupResult;
  const opening = capture.open(DEVICE, SETTINGS, new AbortController().signal);
  return await drive(clock, waitThenStart(target, opening));
}

describe("Android screen capture: open", () => {
  it("pushes the server to a per-session path and starts it with that session's id and the settings", async () => {
    const world = await setup();
    await opened(world);
    expect(world.target.log[0]).toBe(`push ${SERVER} ${DEVICE_JAR}`);
    expect(world.target.log[1]).toBe(
      [
        "shell",
        `CLASSPATH=${DEVICE_JAR}`,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        "5.0.1",
        "scid=1234abcd",
        "log_level=info",
        "tunnel_forward=true",
        "video=true",
        "audio=false",
        "control=false",
        "video_codec=h264",
        "send_device_meta=false",
        "send_dummy_byte=true",
        "send_stream_meta=true",
        "send_frame_meta=true",
        "cleanup=true",
        "max_size=720",
        "max_fps=30",
        "video_bit_rate=1500000",
      ].join(" "),
    );
  });

  it("streams a physical phone through its target: the screen read, the push, the server start and the close's removal go through its run and spawn, and its socket through its connect", async () => {
    const world = await setup({ device: PHONE });
    const opening = world.capture.open(PHONE, SETTINGS, new AbortController().signal);
    const feed = await drive(world.clock, waitThenStart(world.target, opening));

    expect(frameTag((await feed.body.getReader().read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    await drive(world.clock, feed.close());
    // why: the phone's screen is read before the jar is pushed, and the push, the server start and the
    // close's removal all run on the target that carries the phone's serial.
    expect(world.target.steps).toEqual([
      `push ${SERVER} ${DEVICE_JAR}`,
      "server",
      `shell rm -f ${DEVICE_JAR}`,
    ]);
    expect(world.target.powerReads).toEqual([SCREEN_READ_MS]);
    expect(world.target.connects.length).toBeGreaterThan(0);
    expect(world.other.steps).toEqual([]);
    expect(world.other.powerReads).toEqual([]);
    expect(world.other.connects).toEqual([]);
  });

  it("adds stay_awake=true to a phone's server options and to nothing of an emulator's", async () => {
    const emulator = await setup();
    await opened(emulator);
    const phone = await setup({ device: PHONE });
    const opening = phone.capture.open(PHONE, SETTINGS, new AbortController().signal);
    await drive(phone.clock, waitThenStart(phone.target, opening));
    const serverOf = (log: readonly string[]) => log.find((l) => l.includes("app_process"))!;
    const emulatorOptions = serverOf(emulator.target.log).split(" ");
    expect(emulatorOptions).not.toContain("stay_awake=true");
    expect(emulatorOptions).toContain("control=false");
    const phoneOptions = serverOf(phone.target.log).split(" ");
    expect(phoneOptions).toContain("stay_awake=true");
    expect(phoneOptions).toContain("control=false");
    expect(phoneOptions.filter((o) => o !== "stay_awake=true")).toEqual(emulatorOptions);
  });

  it("reads no screen state and sends no wake for an emulator, even when the screen would read asleep", async () => {
    const world = await setup({ power: { code: 0, stdout: "  mWakefulness=Asleep\n" } });
    await opened(world);
    expect(world.target.powerReads).toEqual([]);
    expect(world.target.wakes).toEqual([]);
    expect(world.target.log).not.toContainEqual(expect.stringContaining("dumpsys"));
  });

  it("reaches the server's abstract socket through the device's target, named by the session id", async () => {
    const world = await setup();
    await opened(world);
    expect(world.target.server.peers).toHaveLength(1);
    expect(world.target.server.last.written).toEqual([
      "001chost:transport:emulator-5586",
      "001dlocalabstract:scrcpy_1234abcd",
    ]);
    expect(world.other.connects).toEqual([]);
  });

  it("hands out a body that starts with the session's meta frame", async () => {
    const feed = await opened(await setup());
    const first = await feed.body.getReader().read();
    expect(frameTag(first.value)).toBe(SCREEN_FRAME_TAG.meta);
    expect(JSON.parse(new TextDecoder().decode(first.value!.subarray(5)))).toEqual({
      codec: "h264",
      fps: 30,
      height: 64,
      width: 96,
    });
  });

  it("retries every 100 ms while the server is not listening yet, then streams", async () => {
    const world = await setup({
      server: new AdbServer(["connection-refused", "refuse", "refuse"]),
    });
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const started = world.clock.now();
    const watcher = (async () => {
      while (world.target.server.peers.length < 3)
        await new Promise((resolve) => setImmediate(resolve));
      world.target.server.last.send(streamStart());
    })();
    const feed = await drive(world.clock, opening, 10);
    await watcher;
    expect(world.target.connects).toHaveLength(4);
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(3 * CONNECT_RETRY_MS);
    // why: two drive steps of slack; a retry interval slower than CONNECT_RETRY_MS overshoots this.
    expect(world.clock.now() - started).toBeLessThan(3 * CONNECT_RETRY_MS + 2 * 10);
    expect(frameTag((await feed.body.getReader().read()).value)).toBe(SCREEN_FRAME_TAG.meta);
  });

  it("retries a connection that ends before the server's first byte", async () => {
    const world = await setup({ server: new AdbServer(["silent"]) });
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.target.server.peers.length < 1)
        await new Promise((resolve) => setImmediate(resolve));
      world.target.server.peers[0]!.send("OKAY", "OKAY");
      world.target.server.peers[0]!.close();
      while (world.target.server.peers.length < 2)
        await new Promise((resolve) => setImmediate(resolve));
      world.target.server.last.send(streamStart());
    })();
    await drive(world.clock, opening, 10);
    await watcher;
    expect(world.target.server.peers).toHaveLength(2);
  });

  it("gives up at the start deadline, reporting the server's last output, and cleans up", async () => {
    const world = await setup({
      expectations: [push(), shell({ stderrLines: ["[server] ERROR: no encoder"] }), remove()],
      server: new AdbServer([], "refuse"),
    });
    const started = world.clock.now();
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const error = await drive(world.clock, opening).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/within 15 s/);
    expect((error as Error).message).toMatch(/closed/);
    expect((error as Error).message).toMatch(/no encoder/);
    const failedAt = world.clock.now() - started;
    expect(failedAt).toBeGreaterThanOrEqual(START_DEADLINE_MS);
    expect(failedAt).toBeLessThan(START_DEADLINE_MS + CLOSE_DEADLINE_MS);
    expect(world.target.steps).toEqual([
      `push ${SERVER} ${DEVICE_JAR}`,
      "server",
      `shell rm -f ${DEVICE_JAR}`,
    ]);
    expect(world.target.server.peers.every((peer) => peer.closed)).toBe(true);
  });

  it("fails at once when the server's shell exits before it listens", async () => {
    const world = await setup({
      expectations: [
        push(),
        shell({
          hangs: false,
          result: { code: 1, stderr: "", stdout: "" },
          stderrLines: ["Aborted"],
        }),
        remove(),
      ],
      server: new AdbServer([], "refuse"),
    });
    const started = world.clock.now();
    const error = await drive(
      world.clock,
      world.capture.open(DEVICE, SETTINGS, new AbortController().signal),
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/exited before it streamed/);
    expect((error as Error).message).toMatch(/Aborted/);
    expect(world.clock.now() - started).toBeLessThan(CONNECT_RETRY_MS);
  });

  it("refuses at once when adb has no transport for the serial", async () => {
    const world = await setup({ server: new AdbServer(["no-transport"]) });
    const error = await drive(
      world.clock,
      world.capture.open(DEVICE, SETTINGS, new AbortController().signal),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/not found/);
    expect(world.target.server.peers).toHaveLength(1);
  });

  it("refuses with the server's reason when it cannot configure its encoder", async () => {
    const world = await setup();
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.target.server.peers.length < 1)
        await new Promise((resolve) => setImmediate(resolve));
      world.target.server.last.send(codecId(1));
    })();
    const error = await drive(world.clock, opening).catch((caught: unknown) => caught);
    await watcher;
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/could not configure/);
  });

  it("reports adb's push failure without starting a server", async () => {
    const world = await setup({
      expectations: [push({ code: 1, stderr: "device offline" }), remove()],
    });
    const error = await drive(
      world.clock,
      world.capture.open(DEVICE, SETTINGS, new AbortController().signal),
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/device offline/);
    expect(world.target.steps).toEqual([
      `push ${SERVER} ${DEVICE_JAR}`,
      `shell rm -f ${DEVICE_JAR}`,
    ]);
  });

  it("starts no server when it is stopped while the jar is being copied, and removes the jar", async () => {
    const stop = new AbortController();
    const world = await setup({
      expectations: [{ ...push(), onSpawn: () => stop.abort() }, remove()],
    });
    const opening = world.capture.open(DEVICE, SETTINGS, stop.signal);
    await expect(drive(world.clock, opening)).rejects.toBeInstanceOf(ScreenUnavailableError);
    expect(world.target.log).not.toContainEqual(expect.stringContaining("app_process"));
    expect(world.target.steps.at(-1)).toContain("rm -f");
  });

  it("refuses an open that was stopped before it began, running nothing", async () => {
    const world = await setup({ expectations: [] });
    const stop = new AbortController();
    stop.abort();
    await expect(world.capture.open(DEVICE, SETTINGS, stop.signal)).rejects.toBeInstanceOf(
      ScreenUnavailableError,
    );
    expect(world.target.log).toEqual([]);
    expect(world.target.connects).toEqual([]);
  });

  it("is unavailable, with the reason, while the server jar is missing", async () => {
    expect(await (await setup()).capture.unavailable()).toBeUndefined();
    const world = await setup({ expectations: [], jar: false });
    expect(await world.capture.unavailable()).toMatch(
      /scrcpy-server v5\.0\.1.*\/simlock\/scrcpy-server-v5\.0\.1/,
    );
    await expect(
      world.capture.open(DEVICE, SETTINGS, new AbortController().signal),
    ).rejects.toBeInstanceOf(ScreenUnavailableError);
    expect(world.target.log).toEqual([]);
  });

  it("gives two concurrent opens two session ids, two sockets and two jar paths", async () => {
    const world = await setup({
      expectations: [push(), push(), shell(), shell()],
      scid: null,
    });
    const first = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const second = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.target.server.peers.length < 2)
        await new Promise((resolve) => setImmediate(resolve));
      for (const peer of world.target.server.peers) peer.send(streamStart());
    })();
    await drive(world.clock, Promise.all([first, second]));
    await watcher;
    const sockets = world.target.server.peers.map((peer) => peer.written[1]);
    expect(new Set(sockets).size).toBe(2);
    const jars = world.target.log
      .filter((entry) => entry.startsWith("push "))
      .map((entry) => entry.split(" ")[2]);
    expect(new Set(jars).size).toBe(2);
    for (const socket of sockets) {
      const hex = /scrcpy_([0-9a-f]{8})$/.exec(socket ?? "")?.[1];
      expect(hex).toBeDefined();
      expect(jars).toContain(`/data/local/tmp/simlock-scrcpy-${hex!}.jar`);
    }
  });
});

describe("Android screen capture: a phone's screen state", () => {
  it("wakes a phone whose screen is off through its target with a 10 s limit, reads again, and pushes once the second read says it is on, for each wakefulness that means off", async () => {
    for (const printed of ["Asleep", "Dozing", "Asleep\r", "Dozing "]) {
      const world = await setup({
        device: PHONE,
        power: [
          { code: 0, stdout: `  mWakefulness=${printed}\n` },
          { code: 0, stdout: "  mWakefulness=Awake\n" },
        ],
      });
      const opening = world.capture.open(PHONE, SETTINGS, new AbortController().signal);
      const feed = await drive(world.clock, waitThenStart(world.target, opening));
      expect(frameTag((await feed.body.getReader().read()).value), printed).toBe(
        SCREEN_FRAME_TAG.meta,
      );

      expect(world.target.screenSteps, printed).toEqual(["read", "wake", "read"]);
      expect(world.target.wakes, printed).toEqual([WAKE_MS]);
      expect(world.target.powerReads, printed).toEqual([SCREEN_READ_MS, SCREEN_READ_MS]);
      expect(world.target.log[0], printed).toBe(`push ${SERVER} ${DEVICE_JAR}`);
    }
  });

  it("refuses a phone whose second read still says the screen is off, with its own reason, and pushes nothing, whatever the wake did", async () => {
    for (const second of ["Asleep", "Dozing"]) {
      for (const wake of ["ok", "fail", "slow"] as const) {
        const world = await setup({
          device: PHONE,
          wake,
          power: [
            { code: 0, stdout: "  mWakefulness=Asleep\n" },
            { code: 0, stdout: `  mWakefulness=${second}\n` },
          ],
        });
        const error = await drive(
          world.clock,
          world.capture.open(PHONE, SETTINGS, new AbortController().signal),
        ).catch((caught: unknown) => caught);

        const name = `${second} after a wake that is ${wake}`;
        expect(error, name).toBeInstanceOf(ScreenUnavailableError);
        expect((error as Error).message, name).toBe(SCREEN_OFF);
        // why: a wake that exited non-zero or timed out is not looked at; the second read decides.
        expect(world.target.screenSteps, name).toEqual(["read", "wake", "read"]);
        expect(world.target.steps, name).toEqual([]);
        expect(world.target.connects, name).toEqual([]);
      }
    }
  });

  it.each([
    { name: "Awake", power: { code: 0, stdout: "  mWakefulness=Awake\n" } },
    { name: "Dreaming", power: { code: 0, stdout: "  mWakefulness=Dreaming\n" } },
    { name: "Awaken", power: { code: 0, stdout: "  mWakefulness=Awaken\n" } },
    { name: "asleep", power: { code: 0, stdout: "  mWakefulness=asleep\n" } },
    { name: "no matching line", power: { code: 0, stdout: "  mPolicyBoost=0\n" } },
    { name: "a non-zero exit", power: { code: 1, stdout: "  mWakefulness=Asleep\n" } },
    { name: "a slow read", power: "slow" },
  ] as const)(
    "goes on to the push, without a wake, after one 10 s screen read that says $name",
    async ({ name, power }) => {
      const world = await setup({ device: PHONE, power });
      const opening = world.capture.open(PHONE, SETTINGS, new AbortController().signal);
      // why: a timed-out read ends 10 s of fake clock after the open, and waitThenStart's capped
      // flush-wait cannot span it; the file's uncapped watcher pattern waits for the peer whenever
      // it appears, and drive still ends the run if the open never reaches it.
      const watcher = (async () => {
        while (world.target.server.peers.length === 0)
          await new Promise((resolve) => setImmediate(resolve));
        world.target.server.last.send(streamStart());
      })();
      const feed = await drive(world.clock, opening);
      await watcher;
      expect(frameTag((await feed.body.getReader().read()).value), name).toBe(
        SCREEN_FRAME_TAG.meta,
      );

      expect(world.target.powerReads, name).toEqual([SCREEN_READ_MS]);
      expect(world.target.wakes, name).toEqual([]);
      expect(world.target.log[0], name).toBe(`push ${SERVER} ${DEVICE_JAR}`);
    },
  );

  it("checks for a stop after each of the first read, the wake and the second read, and does nothing after the step it was stopped in", async () => {
    const asleep = { code: 0, stdout: "  mWakefulness=Asleep\n" };
    const awake = { code: 0, stdout: "  mWakefulness=Awake\n" };
    const cases = [
      { name: "the first read", power: [asleep], wake: "ok", wakes: 0, reads: 1, hold: true },
      { name: "the wake", power: [asleep, awake], wake: "slow", wakes: 1, reads: 1, hold: false },
      {
        name: "the second read",
        power: [asleep, "slow"],
        wake: "ok",
        wakes: 1,
        reads: 2,
        hold: false,
      },
    ] as const;
    for (const stage of cases) {
      const stop = new AbortController();
      const world = await setup({
        device: PHONE,
        power: stage.power as unknown as FakeTarget["power"],
        wake: stage.wake,
      });
      world.target.holdReads = stage.hold;
      const opening = world.capture.open(PHONE, SETTINGS, stop.signal);
      // why: stops at the step itself: the step is in flight once its entry is recorded.
      while (
        stage.name === "the first read"
          ? world.target.powerReads.length < 1
          : stage.name === "the wake"
            ? world.target.wakes.length < 1
            : world.target.powerReads.length < 2
      )
        await new Promise((resolve) => setImmediate(resolve));
      stop.abort();
      const failed = await drive(world.clock, opening).catch((caught: unknown) => caught);

      expect(failed, stage.name).toBeInstanceOf(ScreenUnavailableError);
      expect(world.target.wakes.length, stage.name).toBe(stage.wakes);
      expect(world.target.powerReads.length, stage.name).toBe(stage.reads);
      expect(world.target.log, stage.name).toEqual([]);
      expect(world.target.connects, stage.name).toEqual([]);
    }
  });

  it("fails the open with a target's own reason and runs nothing after it, for the first screen read, the wake, the second screen read, the push, the server start and a connection attempt", async () => {
    const stages: readonly {
      readonly name: string;
      readonly power?: FakeTarget["power"];
      readonly wake?: FakeTarget["wake"];
      readonly refuses: (args: readonly string[]) => boolean;
      readonly screenBefore: string[];
      readonly stepsBefore: string[];
    }[] = [
      {
        name: "the first screen read",
        power: "refuse",
        refuses: () => false,
        screenBefore: ["read"],
        stepsBefore: [],
      },
      {
        // why: the wake's exit is ignored, but a closed check at the wake still refuses the open.
        name: "the wake",
        power: { code: 0, stdout: "  mWakefulness=Asleep\n" },
        wake: "refuse",
        refuses: () => false,
        screenBefore: ["read", "wake"],
        stepsBefore: [],
      },
      {
        name: "the second screen read",
        power: [{ code: 0, stdout: "  mWakefulness=Asleep\n" }, "refuse"],
        refuses: () => false,
        screenBefore: ["read", "wake", "read"],
        stepsBefore: [],
      },
      {
        name: "the push",
        refuses: (args) => args[0] === "push",
        screenBefore: ["read"],
        stepsBefore: [],
      },
      {
        name: "the server start",
        refuses: (args) => args.includes("app_process"),
        screenBefore: ["read"],
        stepsBefore: [`push ${SERVER} ${DEVICE_JAR}`, `shell rm -f ${DEVICE_JAR}`],
      },
      {
        // why: the server's spawn sits between the push and the connection attempt, so it is in the
        // log by the time the attempt's check refuses; only the `rm -f` follows it.
        name: "a connection attempt",
        refuses: (args) => args[0] === "connect",
        screenBefore: ["read"],
        stepsBefore: [`push ${SERVER} ${DEVICE_JAR}`, "server", `shell rm -f ${DEVICE_JAR}`],
      },
    ];
    for (const stage of stages) {
      const world = await setup({
        device: PHONE,
        ...(stage.power === undefined ? {} : { power: stage.power }),
        ...(stage.wake === undefined ? {} : { wake: stage.wake }),
        refuses: stage.refuses,
      });
      const started = world.clock.now();
      const error = await drive(
        world.clock,
        world.capture.open(PHONE, SETTINGS, new AbortController().signal),
      ).catch((caught: unknown) => caught);

      expect(error, stage.name).toBeInstanceOf(ScreenUnavailableError);
      expect((error as Error).message, stage.name).toBe(GATE_REFUSAL);
      // why: a refusal that was retried instead of propagated would have spent the start deadline on
      // it, and the viewer would get a start timeout instead of the check's reason.
      expect(world.clock.now() - started, stage.name).toBeLessThan(START_DEADLINE_MS);
      expect(world.target.steps, stage.name).toEqual(stage.stepsBefore);
      expect(world.target.screenSteps, stage.name).toEqual(stage.screenBefore);
    }
  });

  it("sends nothing and settles when the version check is still closed at the jar's removal", async () => {
    const world = await setup({
      device: PHONE,
      refuses: (args) => args.includes("app_process") || args[0] === "shell",
    });
    const error = await drive(
      world.clock,
      world.capture.open(PHONE, SETTINGS, new AbortController().signal),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect(world.target.steps).toEqual([`push ${SERVER} ${DEVICE_JAR}`]);
  });
});

describe("Android screen capture: the start bound", () => {
  it("does not spend the 15 s start bound on the target's check that runs before the server is spawned", async () => {
    // why: the check runs inside the target, before its process exists. The bound is measured from the
    // moment that process started, so a slow first check costs a stream nothing.
    const world = await setup({ acceptFromMs: 20_000, device: PHONE });
    world.target.spawnDelayMs = 8_000;
    const started = world.clock.now();
    const opening = world.capture.open(PHONE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.target.server.peers.length === 0)
        await new Promise((resolve) => setImmediate(resolve));
      world.target.server.last.send(streamStart());
    })();

    const feed = await drive(world.clock, opening, 500);
    await watcher;
    const took = world.clock.now() - started;

    // why: straddled on both sides -- 20 s from the open's start is past the 15 s budget a budget
    // measured from the push would have allowed, and the stream is proof it was not spent.
    expect(took).toBeGreaterThanOrEqual(20_000);
    expect(took).toBeLessThan(20_000 + CLOSE_DEADLINE_MS);
    expect(frameTag((await feed.body.getReader().read()).value)).toBe(SCREEN_FRAME_TAG.meta);
  });

  it("counts a connection attempt's own check inside the 15 s, waits for one still running at the deadline, and then fails as a start timeout", async () => {
    const world = await setup({ server: new AdbServer([], "refuse") });
    world.target.connectDelayMs = START_DEADLINE_MS + 2_000;
    const started = world.clock.now();
    const error = await drive(
      world.clock,
      world.capture.open(DEVICE, SETTINGS, new AbortController().signal),
      500,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/within 15 s/);
    const failedAt = world.clock.now() - started;
    expect(failedAt).toBeGreaterThanOrEqual(START_DEADLINE_MS);
    expect(failedAt).toBeLessThanOrEqual(START_DEADLINE_MS + 5_000 + CLOSE_DEADLINE_MS);
  });
});

describe("Android screen capture: the body", () => {
  it("reads the socket only when its reader asks for a frame", async () => {
    const world = await setup();
    const feed = await opened(world);
    const peer = world.target.server.last;
    peer.send(mediaPacket({ config: true }, SAMPLE.config), mediaPacket({ key: true }, SAMPLE.idr));
    const before = peer.pulls;
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(peer.pulls).toBe(before);
    const reader = feed.body.getReader();
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    expect(peer.pulls).toBe(before);
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.description);
    expect(peer.pulls).toBeGreaterThan(before);
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.keyframe);
  });

  it("delivers every delta, in order, however slowly it is read", async () => {
    const world = await setup();
    const feed = await opened(world);
    const peer = world.target.server.last;
    peer.send(mediaPacket({ config: true }, SAMPLE.config), mediaPacket({ key: true }, SAMPLE.idr));
    // why: a delta frame carries only the picture, so each picture ends in its own index byte.
    for (let index = 0; index < 50; index += 1) {
      const picture = Uint8Array.from(SAMPLE.p1);
      picture[picture.length - 1] = index + 1;
      peer.send(mediaPacket({ pts: index }, picture));
    }
    const reader = feed.body.getReader();
    const deltas: (number | undefined)[] = [];
    for (let index = 0; index < 53; index += 1) {
      for (let flush = 0; flush < 3; flush += 1)
        await new Promise((resolve) => setImmediate(resolve));
      const frame = (await reader.read()).value;
      if (frameTag(frame) === SCREEN_FRAME_TAG.delta) deltas.push(frame?.at(-1));
    }
    expect(deltas).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  });

  it("says a still screen is alive every few seconds, and keeps the frames that follow in order", async () => {
    const world = await setup();
    const feed = await opened(world);
    const peer = world.target.server.last;
    peer.send(mediaPacket({ config: true }, SAMPLE.config), mediaPacket({ key: true }, SAMPLE.idr));
    const reader = feed.body.getReader();
    for (let index = 0; index < 3; index += 1) await reader.read();
    const flushAll = async (): Promise<void> => {
      for (let flush = 0; flush < 10; flush += 1)
        await new Promise((resolve) => setImmediate(resolve));
    };
    for (const round of [1, 2]) {
      const quiet = reader.read();
      let settled = false;
      void quiet.then(() => (settled = true));
      await flushAll();
      world.clock.advance(ALIVE_AFTER_MS - 1);
      await flushAll();
      expect(settled, `round ${String(round)} before ${String(ALIVE_AFTER_MS)} ms`).toBe(false);
      world.clock.advance(1);
      const alive = (await quiet).value;
      expect(frameTag(alive), `round ${String(round)}`).toBe(SCREEN_FRAME_TAG.alive);
      expect(alive?.length, `round ${String(round)}`).toBe(5);
    }
    const next = reader.read();
    const first = Uint8Array.from(SAMPLE.p1);
    first[first.length - 1] = 1;
    const second = Uint8Array.from(SAMPLE.p1);
    second[second.length - 1] = 2;
    peer.send(mediaPacket({ pts: 1 }, first), mediaPacket({ pts: 2 }, second));
    const deltas = [(await next).value, (await reader.read()).value];
    expect(deltas.map(frameTag)).toEqual([SCREEN_FRAME_TAG.delta, SCREEN_FRAME_TAG.delta]);
    expect(deltas.map((frame) => frame?.at(-1))).toEqual([1, 2]);
  });

  it("says nothing is alive while the encoder has not painted a first picture, on an emulator and on a phone", async () => {
    for (const device of [DEVICE, PHONE]) {
      const world = await setup({ device });
      const opening = world.capture.open(device, SETTINGS, new AbortController().signal);
      const feed = await drive(world.clock, waitThenStart(world.target, opening));
      const peer = world.target.server.last;
      peer.send(mediaPacket({ config: true }, SAMPLE.config));
      const reader = feed.body.getReader();
      expect(frameTag((await reader.read()).value), device.deviceId).toBe(SCREEN_FRAME_TAG.meta);
      const quiet = reader.read();
      let settled = false;
      void quiet.then(() => (settled = true));
      for (let flush = 0; flush < 10; flush += 1)
        await new Promise((resolve) => setImmediate(resolve));
      world.clock.advance(ALIVE_AFTER_MS * 3);
      for (let flush = 0; flush < 10; flush += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(settled, device.deviceId).toBe(false);
    }
  });

  it("errors with the server's reason when the device side ends, and cleans up", async () => {
    const world = await setup({
      expectations: [push(), shell({ stderrLines: ["[server] ERROR: Encoding error"] }), remove()],
    });
    const feed = await opened(world);
    const reader = feed.body.getReader();
    await reader.read();
    world.target.server.last.close();
    const error = await drive(world.clock, reader.read()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/Encoding error/);
    await drive(world.clock, feed.close());
    expect(world.target.steps.at(-1)).toBe(`shell rm -f ${DEVICE_JAR}`);
  });
});

describe("Android screen capture: close", () => {
  it("closes the socket, kills a server that outlives it, and removes the jar, once however often it is called", async () => {
    const world = await setup();
    const feed = await opened(world);
    const closes = Promise.all([feed.close(), feed.close()]);
    await drive(world.clock, closes);
    await drive(world.clock, feed.close());
    expect(world.target.server.last.closed).toBe(true);
    expect(await hasEnded(world.target.runner.handles[1]!)).toBe(true);
    expect(world.target.log.filter((entry) => entry.includes("rm"))).toHaveLength(1);
  });

  it("kills a server still running a second after its socket closed, with SIGKILL", async () => {
    const world = await setup({
      expectations: [push(), shell({ ignoresSigterm: true }), remove()],
    });
    const feed = await opened(world);
    const closing = feed.close();
    const server = world.target.runner.handles[1]!;
    await hasEnded(server);
    world.clock.advance(999);
    expect(await hasEnded(server)).toBe(false);
    world.clock.advance(1);
    expect(await hasEnded(server)).toBe(true);
    await drive(world.clock, closing);
  });

  it("resolves within its deadline even when removing the jar never returns", async () => {
    const world = await setup({ expectations: [push(), shell(), { ...remove(), hangs: true }] });
    const feed = await opened(world);
    const started = world.clock.now();
    await drive(world.clock, feed.close());
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(CLOSE_DEADLINE_MS);
    expect(world.clock.now() - started).toBeLessThanOrEqual(CLOSE_DEADLINE_MS + 50);
  });

  it("cancelling the body closes the capture", async () => {
    const world = await setup();
    const feed = await opened(world);
    await drive(world.clock, feed.body.cancel());
    expect(world.target.server.last.closed).toBe(true);
    expect(world.target.log.filter((entry) => entry.includes("rm"))).toHaveLength(1);
  });
});
