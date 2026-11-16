import { describe, expect, it } from "vitest";

import { SCREEN_FRAME_TAG, ScreenUnavailableError } from "../../../core/index.js";

import { CLOSE_DEADLINE_MS, CONNECT_RETRY_MS, START_DEADLINE_MS } from "./session.js";
import {
  SERVER,
  DEVICE_JAR,
  SETTINGS,
  SCREEN_READ_MS,
  DEVICE,
  PHONE,
  AdbServer,
  push,
  shell,
  remove,
  setup,
  drive,
  streamStart,
  frameTag,
  waitThenStart,
  opened,
} from "./test-session.js";
import { codecId } from "./test-scrcpy.js";

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
        "control=true",
        "power_on=false",
        "clipboard_autosync=false",
        "video_codec=h264",
        "video_codec_options=i-frame-interval:int=2",
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
    expect(emulatorOptions).toContain("control=true");
    const phoneOptions = serverOf(phone.target.log).split(" ");
    expect(phoneOptions).toContain("stay_awake=true");
    expect(phoneOptions).toContain("control=true");
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

  it("connects the control socket after the video's zero byte and before the video is read, discards what it sends, and ends the stream when it ends", async () => {
    const world = await setup();
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const feed = await drive(world.clock, waitThenStart(world.target, opening));
    const [video] = world.target.server.peers;
    const [control] = world.target.server.controls;
    expect(world.target.server.peers).toHaveLength(1);
    expect(world.target.server.controls).toHaveLength(1);
    expect(control!.written).toEqual([
      "001chost:transport:emulator-5586",
      "001dlocalabstract:scrcpy_1234abcd",
    ]);
    // why: the video is read only once the control socket is up, and the zero byte is the video's alone:
    // the control socket is answered with nothing after adb's OKAY, so asking it for one would hang.
    expect(video!.pulls).toBeGreaterThan(0);
    expect(control!.pulls).toBeGreaterThan(0);

    control!.send(new Uint8Array(64).fill(7));
    const reader = feed.body.getReader();
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    control!.close();
    await expect(drive(world.clock, reader.read())).rejects.toBeInstanceOf(ScreenUnavailableError);
    expect(video!.closed).toBe(true);
  });

  it("refuses the open, and cleans up, when the control connection is refused", async () => {
    const world = await setup({ server: new AdbServer(["accept", "refuse"]) });
    const opening = world.capture.open(DEVICE, SETTINGS, new AbortController().signal);
    const error = await drive(world.clock, opening).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect((error as Error).message).toMatch(/control connection/);
    expect(world.target.server.peers.every((peer) => peer.closed)).toBe(true);
    expect(world.target.steps.at(-1)).toBe(`shell rm -f ${DEVICE_JAR}`);
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
