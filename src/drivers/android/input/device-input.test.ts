import { describe, expect, it } from "vitest";

import {
  type DeviceInput,
  type InputScreenConfig,
  isUnavailableInput,
  type PhysicalDriverDevice,
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
import type { ScreenTarget } from "../screen/index.js";
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

  constructor(
    readonly serial: string,
    expectations: ScriptedProcessExpectation[],
  ) {
    this.runner = new ScriptedProcessRunner(expectations);
  }

  async run(args: readonly string[]): Promise<ProcessResult> {
    if (args.join(" ") === "shell dumpsys window displays") return this.display;
    this.log.push(args.join(" "));
    return await this.runner.run(ADB, args);
  }

  async spawn(args: readonly string[]): Promise<ProcessHandle> {
    this.log.push(args.join(" "));
    return this.runner.spawn(ADB, args);
  }

  async connect(): Promise<TcpStream> {
    const peer = new Peer();
    peer.send("OKAY", "OKAY", new Uint8Array([0]));
    this.peers.push(peer);
    return peer.stream;
  }
}

function push(): ScriptedProcessExpectation {
  return {
    match: {
      args: ["push", SERVER, /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
    result: { code: 0, stderr: "", stdout: "" },
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

function setup(device: VirtualDriverDevice | PhysicalDriverDevice = DEVICE) {
  const clock = new FakeClock(1_000);
  const target = new FakeTarget(device.address, [push(), shell(), remove()]);
  const factory = createAndroidDeviceInput({
    clock,
    scid: () => SCID,
    serverPath: SERVER,
    targetFor: async (asked) => {
      expect(asked).toBe(device);
      return target;
    },
  });
  return { clock, device, factory, target };
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
        "video=false",
        "audio=false",
        "control=true",
        "power_on=false",
        "send_device_meta=false",
        "send_dummy_byte=true",
        "cleanup=true",
      ].join(" "),
    );
    expect(configs(input)).toEqual([{ height: 2400, orientation: "portrait", width: 1080 }]);
  });
});
