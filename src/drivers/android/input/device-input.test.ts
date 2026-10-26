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

  constructor(
    readonly serial: string,
    expectations: ScriptedProcessExpectation[],
  ) {
    this.runner = new ScriptedProcessRunner(expectations);
  }

  async run(args: readonly string[]): Promise<ProcessResult> {
    this.#check();
    if (args.join(" ") === "shell dumpsys window displays") return this.display;
    this.log.push(args.join(" "));
    return await this.runner.run(ADB, args);
  }

  async spawn(args: readonly string[]): Promise<ProcessHandle> {
    this.#check();
    this.log.push(args.join(" "));
    return this.runner.spawn(ADB, args);
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
function setup(
  device: VirtualDriverDevice | PhysicalDriverDevice = DEVICE,
  expectations = [push(), shell(), remove()],
) {
  const clock = new FakeClock(1_000);
  const target = new FakeTarget(device.address, expectations);
  const other = new FakeTarget("other", []);
  const factory = createAndroidDeviceInput({
    clock,
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
  it("starts a control-only scrcpy and reads the screen's size in its current rotation", async () => {
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
    await settle(world.clock, 2_000);
    expect(seen).toHaveLength(1);
    world.target.display = displays(2400, 1080);
    await settle(world.clock, 2_000);
    expect(seen).toEqual([
      { height: 2400, orientation: "portrait", width: 1080 },
      { height: 1080, orientation: "landscape_left", width: 2400 },
    ]);
    await settle(world.clock, 4_000);
    expect(seen).toHaveLength(2);

    const removal = `shell rm -f ${DEVICE_JAR}`;
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
