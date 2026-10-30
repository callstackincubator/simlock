import { describe, expect, it } from "vitest";

import {
  type DeviceInput,
  type InputScreenConfig,
  isUnavailableInput,
  type PhysicalDriverDevice,
  ScreenUnavailableError,
  type UnavailableDeviceInput,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import {
  FakeClock,
  type Logger,
  type ProcessHandle,
  type ProcessResult,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
  type TcpStream,
} from "../../../ports/index.js";
import { CLOSE_DEADLINE_MS, START_DEADLINE_MS, type ScreenTarget } from "../screen/index.js";
import { createAndroidDeviceInput } from "./index.js";

const ADB = "/sdk/platform-tools/adb";
const SERVER = "/simlock/scrcpy-server-v5.0.1";
const SERIAL = "emulator-5586";
const SCID = 0x1234abcd;
const DEVICE_JAR = "/data/local/tmp/simlock-scrcpy-1234abcd.jar";
const DEVICE: VirtualDriverDevice = {
  address: SERIAL,
  deviceId: "simlock_1",
  driverData: {},
  physical: false,
};

const PHONE: PhysicalDriverDevice = {
  address: "R58M123ABC",
  deviceId: "R58M123ABC",
  driverData: {},
  enrolledApps: [],
  physical: true,
};

// why: the reason a phone's target gives when the shared adb server's version check is closed; the
// input is expected to pass it through as its own, unchanged, and to send nothing after it.
const GATE_REFUSAL =
  "the adb server on port 5037 speaks protocol 40 and Simlock's adb speaks 41. " +
  "No command goes to physical Android devices until they match, and Simlock will not restart that server.";

const SERVER_ARGS = [
  "shell",
  `CLASSPATH=${DEVICE_JAR}`,
  "app_process",
  "/",
  "com.genymobile.scrcpy.Server",
  "5.0.1",
  "scid=1234abcd",
  "log_level=info",
  "tunnel_forward=true",
  "video=false",
  "audio=false",
  "control=true",
  "power_on=false",
  "send_device_meta=false",
  "send_dummy_byte=true",
  "cleanup=true",
].join(" ");

function displays(width: number, height: number): ProcessResult {
  return {
    code: 0,
    stderr: "",
    stdout: [
      "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)",
      "  Display: mDisplayId=0 (organized)",
      `    init=${String(Math.min(width, height))}x${String(Math.max(width, height))} 420dpi cur=${String(width)}x${String(height)} app=${String(width)}x${String(height - 63)} rng=1080x1017-2337x2274`,
      "",
    ].join("\n"),
  };
}

class Peer {
  readonly written: Uint8Array[] = [];
  closed = false;
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
        this.written.push(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
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

// why: the device's target as the driver builds it: `args` start at the adb subcommand. The size
// read is answered from `display`, which a test changes to rotate the device; every other command is
// the scripted runner's.
class FakeTarget implements ScreenTarget {
  readonly log: string[] = [];
  readonly peers: Peer[] = [];
  readonly runner: ScriptedProcessRunner;
  display: ProcessResult = displays(1080, 2400);
  // why: stands in for a closed version check: every command and connection is refused as it refuses them.
  gateClosed = false;
  // why: a server that never opens its socket, as one that failed to start leaves it: adb answers `closed`.
  socketRefused = false;
  // why: how many size reads were asked, how many are running now, and a read that fails or waits for a test to release it.
  reads = 0;
  running = 0;
  maxRunning = 0;
  readFails = false;
  releaseReads: (() => void) | undefined;
  #hold: Promise<void> | undefined;

  holdReads(): void {
    this.#hold = new Promise<void>((resolve) => {
      this.releaseReads = () => {
        this.#hold = undefined;
        resolve();
      };
    });
  }

  constructor(
    readonly serial: string,
    expectations: ScriptedProcessExpectation[],
  ) {
    this.runner = new ScriptedProcessRunner(expectations);
  }

  async run(args: readonly string[]): Promise<ProcessResult> {
    this.#check();
    if (args.join(" ") === "shell dumpsys window displays") return await this.#read();
    this.log.push(args.join(" "));
    return await this.runner.run(ADB, args);
  }

  async spawn(args: readonly string[]): Promise<ProcessHandle> {
    this.#check();
    this.log.push(args.join(" "));
    return this.runner.spawn(ADB, args);
  }

  async #read(): Promise<ProcessResult> {
    this.reads += 1;
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      await this.#hold;
      if (this.readFails) throw new Error("adb: device offline");
      return this.display;
    } finally {
      this.running -= 1;
    }
  }

  #check(): void {
    if (this.gateClosed) throw new ScreenUnavailableError(GATE_REFUSAL);
  }

  async connect(): Promise<TcpStream> {
    this.#check();
    const peer = new Peer();
    if (this.socketRefused) peer.send("OKAY", "FAIL0006closed");
    else peer.send("OKAY", "OKAY", new Uint8Array([0]));
    this.peers.push(peer);
    return peer.stream;
  }
}

function push(code = 0): ScriptedProcessExpectation {
  return {
    match: {
      args: ["push", SERVER, /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
    result: { code, stderr: code === 0 ? "" : "adb: 1 file pushed, 0 skipped", stdout: "" },
  };
}

function shell(): ScriptedProcessExpectation {
  return {
    hangs: true,
    match: { args: ["shell", ...Array.from({ length: 15 }, () => /.*/)], command: ADB },
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

// why: both devices' worlds: the other device's target is here so "it went through this device's
// target" can fail, since an input aimed at the wrong device would show up in the other's log.
class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

function setup(
  device: VirtualDriverDevice | PhysicalDriverDevice = DEVICE,
  expectations = [push(), shell(), remove()],
) {
  const clock = new FakeClock(1_000);
  const target = new FakeTarget(device.address, expectations);
  const other = new FakeTarget("other", []);
  const logger = new SilentLogger();
  const factory = createAndroidDeviceInput({
    clock,
    logger,
    scid: () => SCID,
    serverPath: SERVER,
    targetFor: async (asked) => (asked === device ? target : other),
  });
  return { clock, device, factory, other, target };
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

async function settle(clock: FakeClock, ms: number): Promise<void> {
  for (let spent = 0; spent < ms; spent += 50) {
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    clock.advance(50);
  }
  for (let flush = 0; flush < 10; flush += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

// why: the first two writes on the connection are adb's `host:transport` and `localabstract` requests;
// everything after them is scrcpy's control socket.
function controlPackets(world: World): DataView[] {
  const peer = world.target.peers[0];
  return (peer?.written ?? [])
    .slice(2)
    .map((bytes) => new DataView(bytes.buffer, bytes.byteOffset));
}

// why: scrcpy's touch packet (type 2): action, pointer id, position (x, y, width, height), pressure, buttons.
function touchOf(packet: DataView) {
  return {
    action: packet.getUint8(1),
    height: packet.getUint16(20),
    type: packet.getUint8(0),
    width: packet.getUint16(18),
    x: packet.getInt32(10),
    y: packet.getInt32(14),
  };
}

// why: scrcpy's scroll packet (type 3): position, then two i16 fixed-point values scaled to [-16, 16].
function scrollOf(packet: DataView) {
  return {
    height: packet.getUint16(11),
    horizontal: Math.round((packet.getInt16(13) / 0x8000) * 16),
    type: packet.getUint8(0),
    vertical: Math.round((packet.getInt16(15) / 0x8000) * 16),
    width: packet.getUint16(9),
    x: packet.getInt32(1),
    y: packet.getInt32(5),
  };
}

type World = ReturnType<typeof setup>;

async function open(world: World): Promise<DeviceInput | UnavailableDeviceInput> {
  return await drive(world.clock, world.factory.open(world.device, new AbortController().signal));
}

function opened(opening: DeviceInput | UnavailableDeviceInput): DeviceInput {
  expect(isUnavailableInput(opening) ? opening.unavailable : "opened").toBe("opened");
  return opening as DeviceInput;
}

function configs(input: DeviceInput): InputScreenConfig[] {
  const seen: InputScreenConfig[] = [];
  input.onConfig((config) => seen.push(config));
  return seen;
}

describe("Android device input: open", () => {
  it("starts a control-only scrcpy and reads the screen's size in its current rotation, a phone passes the adb check first, a start that fails is rejected, a rotation is reported once, a close stops the reads, reads never overlap, and a failing read keeps the last size until one succeeds", async () => {
    const world = setup();
    const input = opened(await open(world));
    expect(world.target.log).toEqual([`push ${SERVER} ${DEVICE_JAR}`, SERVER_ARGS]);
    expect(configs(input)).toEqual([{ height: 2400, orientation: "portrait", width: 1080 }]);

    const phone = setup(PHONE);
    const phoneInput = opened(await open(phone));
    expect(phone.target.log).toEqual([`push ${SERVER} ${DEVICE_JAR}`, SERVER_ARGS]);
    expect(configs(phoneInput)).toEqual([{ height: 2400, orientation: "portrait", width: 1080 }]);
    expect(phone.other.log).toEqual([]);

    const closed = setup(PHONE);
    closed.target.gateClosed = true;
    await expect(open(closed)).resolves.toEqual({ unavailable: GATE_REFUSAL });
    expect(closed.target.log).toEqual([]);
    expect(closed.target.peers).toEqual([]);

    const seen = configs(input);
    world.target.display = displays(2400, 1080);
    await settle(world.clock, 1_800);
    expect(seen).toHaveLength(1);
    await settle(world.clock, 400);
    expect(seen).toEqual([
      { height: 2400, orientation: "portrait", width: 1080 },
      { height: 1080, orientation: "landscape_left", width: 2400 },
    ]);
    await settle(world.clock, 4_000);
    expect(seen).toHaveLength(2);

    const removal = `shell rm -f ${DEVICE_JAR}`;

    const ended = setup();
    const endedInput = opened(await open(ended));
    await drive(ended.clock, endedInput.close());
    const readsAtClose = ended.target.reads;
    await settle(ended.clock, 6_000);
    expect(ended.target.reads).toBe(readsAtClose);
    expect(ended.target.peers[0]?.closed).toBe(true);
    // why: handles are push, shell, rm in order; the scripted shell only ends when it is killed, so an ended wait proves the close killed it.
    let shellEnded = false;
    void ended.target.runner.handles[1]?.wait().then(() => {
      shellEnded = true;
    });
    await flush();
    expect(shellEnded).toBe(true);
    expect(ended.target.log).toEqual([`push ${SERVER} ${DEVICE_JAR}`, SERVER_ARGS, removal]);

    const slow = setup();
    const slowInput = opened(await open(slow));
    slow.target.holdReads();
    await settle(slow.clock, 2_100);
    await settle(slow.clock, 8_000);
    expect(slow.target.reads).toBe(2);
    expect(slow.target.maxRunning).toBe(1);
    slow.target.releaseReads?.();
    await settle(slow.clock, 2_100);
    expect(slow.target.reads).toBeGreaterThan(2);
    await drive(slow.clock, slowInput.close());

    const failing = setup();
    const failingInput = opened(await open(failing));
    const kept = configs(failingInput);
    failing.target.readFails = true;
    await settle(failing.clock, 7_000);
    expect(failing.target.reads).toBeGreaterThan(3);
    expect(kept).toEqual([{ height: 2400, orientation: "portrait", width: 1080 }]);
    failing.target.display = displays(2400, 1080);
    failing.target.readFails = false;
    await settle(failing.clock, 2_100);
    expect(kept).toHaveLength(2);
    const silent = setup();
    silent.target.socketRefused = true;
    const started = silent.clock.now();
    await expect(open(silent)).rejects.toThrow("did not accept a connection");
    expect(silent.clock.now() - started).toBeGreaterThanOrEqual(START_DEADLINE_MS);
    expect(silent.clock.now() - started).toBeLessThanOrEqual(START_DEADLINE_MS + CLOSE_DEADLINE_MS);
    expect(silent.target.log).toEqual([`push ${SERVER} ${DEVICE_JAR}`, SERVER_ARGS, removal]);

    const unpushed = setup(DEVICE, [push(1), remove()]);
    await expect(open(unpushed)).rejects.toThrow("could not copy the screen server");
    expect(unpushed.target.log).toEqual([`push ${SERVER} ${DEVICE_JAR}`, removal]);

    const sizeless = setup();
    sizeless.target.display = { code: 0, stderr: "", stdout: "Display: mDisplayId=0\n" };
    await expect(open(sizeless)).rejects.toThrow("did not report its screen size");
    expect(sizeless.target.log).toEqual([]);
  });
});

describe("Android device input: send", () => {
  it("turns touches and scrolls into scrcpy packets at pixel positions for the device's size", async () => {
    for (const [width, height] of [
      [1080, 2400],
      [2400, 1080],
    ] as const) {
      const world = setup();
      world.target.display = displays(width, height);
      const input = opened(await open(world));
      input.send({ kind: "touch", type: "begin", x: 0.5, y: 0.25 });
      input.send({ kind: "touch", type: "move", x: 0.5, y: 0.5 });
      input.send({ kind: "touch", type: "end", x: 0.5, y: 0.5 });
      input.send({ dx: 0, dy: 0.1, kind: "scroll" });
      input.send({ dx: 0.1, dy: 0, kind: "scroll", x: 0.25, y: 0.75 });
      await flush();
      expect(controlPackets(world)).toHaveLength(5);
      const [begin, move, end, down, right] = controlPackets(world);
      const at = (fx: number, fy: number) => ({
        height,
        width,
        x: Math.round(fx * width),
        y: Math.round(fy * height),
      });
      const label = `${String(width)}x${String(height)}`;
      expect(
        [begin, move, end].map((packet) => touchOf(packet as DataView)),
        label,
      ).toEqual([
        { ...at(0.5, 0.25), action: 0, type: 2 },
        { ...at(0.5, 0.5), action: 2, type: 2 },
        { ...at(0.5, 0.5), action: 1, type: 2 },
      ]);
      expect(scrollOf(down as DataView), label).toEqual({
        ...at(0.5, 0.5),
        horizontal: 0,
        type: 3,
        vertical: 2,
      });
      expect(scrollOf(right as DataView), label).toEqual({
        ...at(0.25, 0.75),
        horizontal: -2,
        type: 3,
        vertical: 0,
      });
    }

    const edge = setup();
    const edgeInput = opened(await open(edge));
    edgeInput.send({ kind: "touch", type: "begin", x: 1, y: 1 });
    edgeInput.send({ dx: 5, dy: 5, kind: "scroll" });
    edgeInput.send({ dx: -5, dy: -5, kind: "scroll" });
    await flush();
    const [corner, far, back] = controlPackets(edge);
    expect(touchOf(corner as DataView)).toMatchObject({ x: 1079, y: 2399 });
    expect(scrollOf(far as DataView)).toMatchObject({ horizontal: -16, vertical: 16 });
    expect(scrollOf(back as DataView)).toMatchObject({ horizontal: 16, vertical: -16 });
  });
});

describe("Android device input: keys", () => {
  it("turns buttons and HID keys into scrcpy keycodes, holding a modifier in the meta state until it is released", async () => {
    const world = setup();
    const input = opened(await open(world));
    for (const button of ["home", "app_switcher", "lock", "back"] as const) {
      input.send({ button, kind: "button" });
    }
    const tap = (usage: number) => {
      input.send({ kind: "key", type: "down", usage });
      input.send({ kind: "key", type: "up", usage });
    };
    for (const usage of [0x04, 0x1e, 0x27, 0x28, 0x2a, 0x3a]) tap(usage);
    input.send({ kind: "key", type: "down", usage: 0xe1 });
    input.send({ kind: "key", type: "down", usage: 0x04 });
    input.send({ kind: "key", type: "up", usage: 0x04 });
    input.send({ kind: "key", type: "up", usage: 0xe1 });
    input.send({ kind: "key", type: "down", usage: 0x04 });
    await flush();
    const keys = controlPackets(world).map((packet) => ({
      action: packet.getUint8(1),
      keycode: packet.getInt32(2),
      meta: packet.getInt32(10),
      type: packet.getUint8(0),
    }));
    const key = (keycode: number, action: number, meta = 0) => ({ action, keycode, meta, type: 0 });
    expect(keys).toEqual([
      key(3, 0),
      key(3, 1),
      key(187, 0),
      key(187, 1),
      key(26, 0),
      key(26, 1),
      key(4, 0),
      key(4, 1),
      key(29, 0),
      key(29, 1),
      key(8, 0),
      key(8, 1),
      key(7, 0),
      key(7, 1),
      key(66, 0),
      key(66, 1),
      key(67, 0),
      key(67, 1),
      key(59, 0, 0x41),
      key(29, 0, 0x41),
      key(29, 1, 0x41),
      key(59, 1),
      key(29, 0),
    ]);
  });
});

describe("Android device input: failure", () => {
  it("reports a control socket that closes mid-session as failed, and not one the input closed itself", async () => {
    const world = setup();
    const input = opened(await open(world));
    const failures: string[] = [];
    input.onFailed((error) => failures.push(error.message));
    world.target.peers[0]?.close();
    await flush();
    expect(failures).toEqual(["The input server on emulator-5586 closed its control socket"]);

    const quiet = setup();
    const closing = opened(await open(quiet));
    const none: string[] = [];
    closing.onFailed((error) => none.push(error.message));
    await drive(quiet.clock, closing.close());
    await flush();
    expect(none).toEqual([]);
  });
});
