import { describe, expect, it } from "vitest";

import {
  type PhysicalDriverDevice,
  SCREEN_FRAME_TAG,
  ScreenNotSupportedError,
  ScreenUnavailableError,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
  type TcpStream,
  type TcpStreamConnector,
} from "../../../ports/index.js";
import {
  ALIVE_AFTER_MS,
  CLOSE_DEADLINE_MS,
  CONNECT_RETRY_MS,
  createAndroidScreenCapture,
  START_DEADLINE_MS,
} from "./session.js";
import { codecId, concatBytes, mediaPacket, SAMPLE, sessionPacket } from "./test-scrcpy.js";

const ADB = "/sdk/platform-tools/adb";
const SERVER = "/simlock/scrcpy-server-v5.0.1";
const SERIAL = "emulator-5586";
const PORT = 5038;
const SCID = 0x1234abcd;
const DEVICE_JAR = "/data/local/tmp/simlock-scrcpy-1234abcd.jar";
const SETTINGS = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };
const DEVICE: VirtualDriverDevice = {
  address: SERIAL,
  deviceId: "simlock_1",
  driverData: {},
  physical: false,
};
const ENV = { ANDROID_ADB_SERVER_PORT: String(PORT), ANDROID_AVD_HOME: "/root", PATH: "/bin" };

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

class AdbServer implements TcpStreamConnector {
  readonly peers: Peer[] = [];
  readonly ports: number[] = [];
  readonly #behaviours: Behaviour[];

  constructor(
    behaviours: Behaviour[] = [],
    readonly otherwise: Behaviour = "accept",
  ) {
    this.#behaviours = behaviours;
  }

  async connect(port: number): Promise<TcpStream> {
    this.ports.push(port);
    const behaviour = this.#behaviours.shift() ?? this.otherwise;
    if (behaviour === "connection-refused") throw new Error("connect ECONNREFUSED 127.0.0.1");
    const peer = new Peer();
    this.peers.push(peer);
    if (behaviour === "no-transport") peer.send("FAIL0020device 'emulator-5586' not found");
    if (behaviour === "refuse") peer.send("OKAY", "FAIL0006closed");
    if (behaviour === "accept") peer.send("OKAY", "OKAY", new Uint8Array([0]));
    return peer.stream;
  }

  get last(): Peer {
    const peer = this.peers.at(-1);
    if (peer === undefined) throw new Error("no connection");
    return peer;
  }
}

function push(result: Partial<{ code: number; stderr: string }> = {}): ScriptedProcessExpectation {
  return {
    match: {
      args: ["-s", SERIAL, "push", SERVER, /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/],
      command: ADB,
    },
    result: { code: result.code ?? 0, stderr: result.stderr ?? "", stdout: "" },
  };
}

function shell(extra: Partial<ScriptedProcessExpectation> = {}): ScriptedProcessExpectation {
  return {
    hangs: true,
    match: {
      args: ["-s", SERIAL, "shell", ...Array.from({ length: 20 }, () => /.*/)],
      command: ADB,
    },
    ...extra,
  };
}

function remove(): ScriptedProcessExpectation {
  return {
    match: {
      args: [
        "-s",
        SERIAL,
        "shell",
        "rm",
        "-f",
        /^\/data\/local\/tmp\/simlock-scrcpy-[0-9a-f]{8}\.jar$/,
      ],
      command: ADB,
    },
  };
}

async function setup(
  options: {
    readonly expectations?: ScriptedProcessExpectation[];
    readonly server?: AdbServer;
    readonly jar?: boolean;
    readonly scid?: (() => number) | null;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  if (options.jar !== false) {
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(SERVER, "jar");
  }
  const runner = new ScriptedProcessRunner(options.expectations ?? [push(), shell(), remove()]);
  const server = options.server ?? new AdbServer();
  const capture = createAndroidScreenCapture({
    adb: ADB,
    adbServerPort: PORT,
    clock,
    env: () => ({ ...ENV }),
    filesystem,
    processRunner: runner,
    serialOf: () => SERIAL,
    serverPath: SERVER,
    tcp: server,
    ...(options.scid === null ? {} : { scid: options.scid ?? (() => SCID) }),
  });
  return { capture, clock, runner, server };
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

async function opened(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { capture, clock, server } = setupResult;
  const opening = capture.open(DEVICE, SETTINGS, new AbortController().signal);
  const feed = await drive(clock, waitThenStart(server, opening));
  return feed;
}

async function waitThenStart<T>(server: AdbServer, opening: Promise<T>): Promise<T> {
  for (let tries = 0; tries < 100 && server.peers.length === 0; tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  server.last.send(streamStart());
  return await opening;
}

describe("Android screen capture: open", () => {
  it("pushes the server to a per-session path and starts it with that session's id and the settings", async () => {
    const world = await setup();
    await opened(world);
    expect(world.runner.calls[0]).toMatchObject({
      args: ["-s", SERIAL, "push", SERVER, DEVICE_JAR],
      command: ADB,
      options: { env: ENV },
    });
    expect(world.runner.calls[1]).toMatchObject({ command: ADB, options: { env: ENV } });
    expect(world.runner.calls[1]!.args).toEqual([
      "-s",
      SERIAL,
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
    ]);
  });

  it("reaches the server's abstract socket through Simlock's adb server, named by the session id", async () => {
    const world = await setup();
    await opened(world);
    expect(world.server.ports).toEqual([PORT]);
    expect(world.server.last.written).toEqual([
      "001chost:transport:emulator-5586",
      "001dlocalabstract:scrcpy_1234abcd",
    ]);
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
      while (world.server.peers.length < 3) await new Promise((resolve) => setImmediate(resolve));
      world.server.last.send(streamStart());
    })();
    const feed = await drive(world.clock, opening, 10);
    await watcher;
    expect(world.server.ports).toHaveLength(4);
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(3 * CONNECT_RETRY_MS);
    expect(frameTag((await feed.body.getReader().read()).value)).toBe(SCREEN_FRAME_TAG.meta);
  });

  it("retries a connection that ends before the server's first byte", async () => {
    const world = await setup({ server: new AdbServer(["silent"]) });
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.server.peers.length < 1) await new Promise((resolve) => setImmediate(resolve));
      world.server.peers[0]!.send("OKAY", "OKAY");
      world.server.peers[0]!.close();
      while (world.server.peers.length < 2) await new Promise((resolve) => setImmediate(resolve));
      world.server.last.send(streamStart());
    })();
    await drive(world.clock, opening, 10);
    await watcher;
    expect(world.server.peers).toHaveLength(2);
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
    expect(world.runner.calls.map((call) => call.args.slice(2, 4))).toEqual([
      ["push", SERVER],
      ["shell", `CLASSPATH=${DEVICE_JAR}`],
      ["shell", "rm"],
    ]);
    expect(world.server.peers.every((peer) => peer.closed)).toBe(true);
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
    expect(world.clock.now() - started).toBeLessThan(START_DEADLINE_MS);
  });

  it("refuses at once when adb has no transport for the serial", async () => {
    const world = await setup({ server: new AdbServer(["no-transport"]) });
    const error = await drive(
      world.clock,
      world.capture.open(DEVICE, SETTINGS, new AbortController().signal),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/not found/);
    expect(world.server.peers).toHaveLength(1);
  });

  it("refuses with the server's reason when it cannot configure its encoder", async () => {
    const world = await setup();
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.server.peers.length < 1) await new Promise((resolve) => setImmediate(resolve));
      world.server.last.send(codecId(1));
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
    expect(world.runner.calls.map((call) => call.args[2])).toEqual(["push", "shell"]);
    expect(world.runner.calls[1]!.args.slice(3)).toEqual(["rm", "-f", DEVICE_JAR]);
  });

  it("refuses a physical device as not supported, before running anything", async () => {
    const world = await setup({ expectations: [] });
    await expect(
      world.capture.open(
        { ...DEVICE, enrolledApps: [], physical: true } as PhysicalDriverDevice,
        SETTINGS,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ScreenNotSupportedError);
    expect(world.runner.calls).toEqual([]);
  });

  it("starts no server when it is stopped while the jar is being copied, and removes the jar", async () => {
    const stop = new AbortController();
    const world = await setup({
      expectations: [{ ...push(), onSpawn: () => stop.abort() }, remove()],
    });
    const opening = world.capture.open(DEVICE, SETTINGS, stop.signal);
    await expect(drive(world.clock, opening)).rejects.toBeInstanceOf(ScreenUnavailableError);
    expect(world.runner.calls.map((call) => call.args.join(" "))).not.toContainEqual(
      expect.stringContaining("app_process"),
    );
    expect(world.runner.calls.at(-1)?.args.join(" ")).toContain("rm -f");
  });

  it("refuses an open that was stopped before it began, running nothing", async () => {
    const world = await setup({ expectations: [] });
    const stop = new AbortController();
    stop.abort();
    await expect(world.capture.open(DEVICE, SETTINGS, stop.signal)).rejects.toBeInstanceOf(
      ScreenUnavailableError,
    );
    expect(world.runner.calls).toEqual([]);
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
    expect(world.runner.calls).toEqual([]);
  });

  it("gives two concurrent opens two session ids, two sockets and two jar paths", async () => {
    const world = await setup({
      expectations: [push(), push(), shell(), shell()],
      scid: null,
    });
    const first = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const second = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const watcher = (async () => {
      while (world.server.peers.length < 2) await new Promise((resolve) => setImmediate(resolve));
      for (const peer of world.server.peers) peer.send(streamStart());
    })();
    await drive(world.clock, Promise.all([first, second]));
    await watcher;
    const sockets = world.server.peers.map((peer) => peer.written[1]);
    expect(new Set(sockets).size).toBe(2);
    const jars = world.runner.calls
      .filter((call) => call.args[2] === "push")
      .map((call) => call.args[4]);
    expect(new Set(jars).size).toBe(2);
    for (const socket of sockets) {
      const hex = /scrcpy_([0-9a-f]{8})$/.exec(socket ?? "")?.[1];
      expect(hex).toBeDefined();
      expect(jars).toContain(`/data/local/tmp/simlock-scrcpy-${hex!}.jar`);
    }
  });
});

describe("Android screen capture: the body", () => {
  it("reads the socket only when its reader asks for a frame", async () => {
    const world = await setup();
    const feed = await opened(world);
    const peer = world.server.last;
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
    const peer = world.server.last;
    peer.send(mediaPacket({ config: true }, SAMPLE.config), mediaPacket({ key: true }, SAMPLE.idr));
    for (let index = 0; index < 50; index += 1) peer.send(mediaPacket({ pts: index }, SAMPLE.p1));
    const reader = feed.body.getReader();
    const tags: (number | undefined)[] = [];
    for (let index = 0; index < 53; index += 1) {
      for (let flush = 0; flush < 3; flush += 1)
        await new Promise((resolve) => setImmediate(resolve));
      tags.push(frameTag((await reader.read()).value));
    }
    expect(tags.filter((tag) => tag === SCREEN_FRAME_TAG.delta)).toHaveLength(50);
  });

  it("says a still screen is alive every few seconds, and keeps the frames that follow in order", async () => {
    const world = await setup();
    const feed = await opened(world);
    const peer = world.server.last;
    peer.send(mediaPacket({ config: true }, SAMPLE.config), mediaPacket({ key: true }, SAMPLE.idr));
    const reader = feed.body.getReader();
    for (let index = 0; index < 3; index += 1) await reader.read();
    const quiet = reader.read();
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    world.clock.advance(ALIVE_AFTER_MS);
    const alive = (await quiet).value;
    expect(frameTag(alive)).toBe(SCREEN_FRAME_TAG.alive);
    expect(alive?.length).toBe(5);
    const next = reader.read();
    peer.send(mediaPacket({ pts: 1 }, SAMPLE.p1));
    expect(frameTag((await next).value)).toBe(SCREEN_FRAME_TAG.delta);
  });

  it("says nothing is alive while the encoder has not painted a first picture", async () => {
    const world = await setup();
    const feed = await opened(world);
    const peer = world.server.last;
    peer.send(mediaPacket({ config: true }, SAMPLE.config));
    const reader = feed.body.getReader();
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    const quiet = reader.read();
    let settled = false;
    void quiet.then(() => (settled = true));
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    world.clock.advance(ALIVE_AFTER_MS * 3);
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  });

  it("errors with the server's reason when the device side ends, and cleans up", async () => {
    const world = await setup({
      expectations: [push(), shell({ stderrLines: ["[server] ERROR: Encoding error"] }), remove()],
    });
    const feed = await opened(world);
    const reader = feed.body.getReader();
    await reader.read();
    world.server.last.close();
    const error = await drive(world.clock, reader.read()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/Encoding error/);
    await drive(world.clock, feed.close());
    expect(world.runner.calls.at(-1)?.args.slice(2)).toEqual(["shell", "rm", "-f", DEVICE_JAR]);
  });
});

describe("Android screen capture: close", () => {
  it("closes the socket, kills a server that outlives it, and removes the jar, once however often it is called", async () => {
    const world = await setup();
    const feed = await opened(world);
    const closes = Promise.all([feed.close(), feed.close()]);
    await drive(world.clock, closes);
    await drive(world.clock, feed.close());
    expect(world.server.last.closed).toBe(true);
    expect(await hasEnded(world.runner.handles[1]!)).toBe(true);
    expect(world.runner.calls.filter((call) => call.args.includes("rm"))).toHaveLength(1);
  });

  it("kills a server still running a second after its socket closed, with SIGKILL", async () => {
    const world = await setup({
      expectations: [push(), shell({ ignoresSigterm: true }), remove()],
    });
    const feed = await opened(world);
    const closing = feed.close();
    const server = world.runner.handles[1]!;
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
    expect(world.server.last.closed).toBe(true);
    expect(world.runner.calls.filter((call) => call.args.includes("rm"))).toHaveLength(1);
  });
});
