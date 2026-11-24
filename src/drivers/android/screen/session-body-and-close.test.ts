import { describe, expect, it } from "vitest";

import { SCREEN_FRAME_TAG, ScreenUnavailableError } from "../../../core/index.js";

import { ALIVE_AFTER_MS, CLOSE_DEADLINE_MS } from "./session.js";
import {
  DEVICE_JAR,
  SETTINGS,
  DEVICE,
  PHONE,
  push,
  shell,
  remove,
  setup,
  drive,
  hasEnded,
  frameTag,
  waitThenStart,
  opened,
} from "./test-session.js";
import { mediaPacket, SAMPLE, sessionPacket } from "./test-scrcpy.js";

const RESET_VIDEO = "\u0011";

async function settle(): Promise<void> {
  for (let flush = 0; flush < 10; flush += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("Android screen capture: the key frame bound", () => {
  it("sends reset video on the control socket when no key frame came for 4 s", async () => {
    // why: a still screen: a reset at 4 s and again at 8 s, none before.
    const still = await setup();
    await opened(still);
    const stillControl = still.target.server.controls[0]!;
    still.clock.advance(3_999);
    await settle();
    expect(stillControl.written.slice(2)).toEqual([]);
    still.clock.advance(1);
    await settle();
    expect(stillControl.written.slice(2)).toEqual([RESET_VIDEO]);
    still.clock.advance(4_000);
    await settle();
    expect(stillControl.written.slice(2)).toEqual([RESET_VIDEO, RESET_VIDEO]);

    // why: a key frame at 3 s moves the reset from 4 s to 7 s, and the session the reset starts is relayed whole.
    const moving = await setup();
    const feed = await opened(moving);
    const peer = moving.target.server.last;
    const control = moving.target.server.controls[0]!;
    const reader = feed.body.getReader();
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    moving.clock.advance(3_000);
    peer.send(mediaPacket({ config: true }, SAMPLE.config), mediaPacket({ key: true }, SAMPLE.idr));
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.description);
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.keyframe);
    moving.clock.advance(3_999);
    await settle();
    expect(control.written.slice(2)).toEqual([]);
    moving.clock.advance(1);
    await settle();
    expect(control.written.slice(2)).toEqual([RESET_VIDEO]);
    peer.send(
      sessionPacket(96, 64),
      mediaPacket({ config: true }, SAMPLE.config),
      mediaPacket({ key: true }, SAMPLE.idr),
    );
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.description);
    expect(frameTag((await reader.read()).value)).toBe(SCREEN_FRAME_TAG.keyframe);

    // why: once the viewer goes, the timer is gone with the session: no reset is written to a closed socket.
    reader.releaseLock();
    await drive(moving.clock, feed.body.cancel());
    moving.clock.advance(10_000);
    await settle();
    expect(control.written.slice(2)).toEqual([RESET_VIDEO]);

    // why: a write that fails ends the stream: its promise is gone, so it does not go on without it.
    const failing = await setup();
    const failingFeed = await opened(failing);
    const failingReader = failingFeed.body.getReader();
    expect(frameTag((await failingReader.read()).value)).toBe(SCREEN_FRAME_TAG.meta);
    failing.target.server.controls[0]!.failWrites = true;
    const ended = failingReader.read();
    failing.clock.advance(4_000);
    await expect(ended).rejects.toBeInstanceOf(ScreenUnavailableError);
  });

  it("relays a still screen's key frame 4 s plus the answer after the last one when the device takes 5 s to answer reset video", async () => {
    // why: scrcpy v5.0.1 answers reset video by preparing a new capture and encoder, and when another reset
    // came while it did, it sends nothing and prepares again (SurfaceEncoder.java:142,
    // `if (!captureControl.isResetRequested())`). This device takes 5 s to prepare, as a just-booted emulator
    // on a loaded host does (#1762): a reset written during the answer starts the answer again.
    const ANSWER_MS = 5_000;
    const still = await setup();
    const feed = await opened(still);
    const startedAt = still.clock.now();
    const peer = still.target.server.last;
    const control = still.target.server.controls[0]!;
    const reader = feed.body.getReader();
    const keyFramesAt: number[] = [];
    void (async () => {
      for (;;) {
        const step = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (step.done || step.value === undefined) return;
        if (frameTag(step.value) === SCREEN_FRAME_TAG.keyframe)
          keyFramesAt.push(still.clock.now() - startedAt);
      }
    })();
    let resets = 0;
    let answerAt: number | undefined;
    for (let spent = 0; spent < 20_000; spent += 500) {
      still.clock.advance(500);
      await settle();
      const written = control.written.slice(2).length;
      if (written > resets) {
        resets = written;
        answerAt = still.clock.now() + ANSWER_MS;
      }
      if (answerAt !== undefined && still.clock.now() >= answerAt) {
        answerAt = undefined;
        peer.send(
          sessionPacket(96, 64),
          mediaPacket({ config: true }, SAMPLE.config),
          mediaPacket({ key: true }, SAMPLE.idr),
        );
        await settle();
      }
    }
    expect(keyFramesAt, "key frames, in ms after the open, of a still screen").toEqual([
      4_000 + ANSWER_MS,
      2 * (4_000 + ANSWER_MS),
    ]);
    await drive(still.clock, reader.cancel());
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
