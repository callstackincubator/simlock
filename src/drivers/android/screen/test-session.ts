import {
  type PhysicalDriverDevice,
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

import { createAndroidScreenCapture, type ScreenTarget } from "./session.js";
import { codecId, concatBytes, sessionPacket } from "./test-scrcpy.js";

const ADB = "/sdk/platform-tools/adb";
export const SERVER = "/simlock/scrcpy-server-v5.0.1";
const SERIAL = "emulator-5586";
const PHONE_SERIAL = "R58M123ABC";
const SCID = 0x1234abcd;
export const DEVICE_JAR = "/data/local/tmp/simlock-scrcpy-1234abcd.jar";
export const SETTINGS = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };
export const SCREEN_READ_MS = 10_000;
export const WAKE_MS = 10_000;
export const DEVICE: VirtualDriverDevice = {
  address: SERIAL,
  deviceId: "simlock_1",
  driverData: {},
  physical: false,
};
export const PHONE: PhysicalDriverDevice = {
  address: PHONE_SERIAL,
  deviceId: PHONE_SERIAL,
  driverData: {},
  enrolledApps: [],
  physical: true,
};

// why: the reason a phone's target gives when the shared adb server's version check is closed. The
// capture is expected to pass it through as its own, unchanged, and to run nothing after it.
export const GATE_REFUSAL =
  "the adb server on port 5037 speaks protocol 40 and Simlock's adb speaks 41. " +
  "No command goes to physical Android devices until they match, and Simlock will not restart that server.";
export const SCREEN_OFF =
  "The phone's screen is off and did not turn on. Turn it on and ask for the stream again.";
const WAKE_ARGS = "shell input keyevent KEYCODE_WAKEUP";

export type Behaviour = "accept" | "refuse" | "no-transport" | "connection-refused" | "silent";

class Peer {
  readonly written: string[] = [];
  closed = false;
  pulls = 0;
  // why: set when the connection asked for a socket the server already served: scrcpy's control socket.
  control = false;
  // why: a write that fails, as a socket the device has dropped does.
  failWrites = false;
  onWrite: ((text: string) => void) | undefined;
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
      end: () => undefined,
      readable,
      write: async (bytes) => {
        if (this.failWrites) throw new Error("write failed");
        const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
        this.written.push(text);
        this.onWrite?.(text);
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
export class AdbServer {
  // why: the video connections, one per session id; the control connections are kept apart so a
  // test that waits for "the connection" means the one the video comes on.
  readonly peers: Peer[] = [];
  readonly controls: Peer[] = [];
  readonly #behaviours: Behaviour[];
  readonly #served = new Set<string>();

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
    if (behaviour === "accept") {
      // why: scrcpy writes its zero byte on the first socket a session id is opened on, and nothing on the second.
      peer.onWrite = (text) => {
        peer.send("OKAY");
        if (!text.includes("localabstract:")) return;
        if (this.#served.has(text)) {
          peer.control = true;
          this.peers.splice(this.peers.indexOf(peer), 1);
          this.controls.push(peer);
        } else {
          this.#served.add(text);
          peer.send(new Uint8Array([0]));
        }
      };
    }
    return peer;
  }

  get last(): Peer {
    const peer = this.peers.at(-1);
    if (peer === undefined) throw new Error("no connection");
    return peer;
  }
}

export interface PowerAnswer {
  readonly code: number | null;
  readonly stdout: string;
}

// why: the device's capture target as the driver builds it. `args` start at the adb subcommand, so
// the serial and the adb server are the target's and not the capture's: this fake records what it
// was asked to run, and the commands themselves are the scripted runner's, so a push can fail, a
// server can hang and a kill can be escalated exactly as before the target existed.
export class FakeTarget implements ScreenTarget {
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

  // fallow-ignore-next-line unused-class-member -- the session tests read it on the harness this file builds.
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

export function push(
  result: Partial<{ code: number; stderr: string }> = {},
): ScriptedProcessExpectation {
  return {
    match: {
      args: ["push", SERVER, /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
    result: { code: result.code ?? 0, stderr: result.stderr ?? "", stdout: "" },
  };
}

// why: a phone's server command carries one more option (stay_awake) than an emulator's.
export function shell(
  extra: Partial<ScriptedProcessExpectation> = {},
  options = 15,
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

export function remove(): ScriptedProcessExpectation {
  return {
    match: {
      args: ["shell", "rm", "-f", /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
  };
}

// why: both devices' worlds — the other device's target is here so "it went through this device's
// target" can fail; a capture that aimed at the wrong device would show up in the other's lists.
export async function setup(
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
    options.expectations ?? [push(), shell({}, phone ? 16 : 15), remove()],
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

export async function drive<T>(clock: FakeClock, promise: Promise<T>, stepMs = 50): Promise<T> {
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

export function streamStart(): Uint8Array {
  return concatBytes(codecId(), sessionPacket(96, 64));
}

export async function hasEnded(handle: { wait(): Promise<unknown> }): Promise<boolean> {
  let ended = false;
  void handle.wait().then(() => (ended = true));
  for (let flush = 0; flush < 5; flush += 1) await new Promise((resolve) => setImmediate(resolve));
  return ended;
}

export function frameTag(frame: Uint8Array | undefined): number | undefined {
  return frame?.[4];
}

export async function waitThenStart<T>(target: FakeTarget, opening: Promise<T>): Promise<T> {
  for (let tries = 0; tries < 100 && target.server.peers.length === 0; tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  target.server.last.send(streamStart());
  return await opening;
}

export async function opened(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { capture, clock, target } = setupResult;
  const opening = capture.open(DEVICE, SETTINGS, new AbortController().signal);
  return await drive(clock, waitThenStart(target, opening));
}
