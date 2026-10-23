import { describe, expect, it } from "vitest";

import {
  type Platform,
  ScreenNotSupportedError,
  type ScreenSettings,
  ScreenUnavailableError,
} from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import type { StreamCaller } from "./caller.js";
import { createCaptureRegistry } from "./captures.js";
import type { CapturedStream } from "./feed.js";
import { StreamRefusalError } from "./refusal.js";
import { ScriptedFeed, TestRegistry } from "./test-fixtures.js";
import { createWorkerStreamLink } from "./worker-link.js";

const AGENT: StreamCaller = { principal: "tok_agent", role: "agent" };
const OPERATOR: StreamCaller = { principal: "tok_op", role: "operator" };
const SETTINGS: ScreenSettings = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };
const DEVICE = { deviceId: "dev_1" };

interface Opened {
  readonly platform: Platform;
  readonly deviceId: string;
  readonly settings: ScreenSettings;
  readonly feed: ScriptedFeed;
}

function setup(options: { refuseWith?: Error } = {}) {
  const registry = new TestRegistry([{ id: "dev_1", platform: "android" }]);
  const clock = new FakeClock();
  const captures = createCaptureRegistry();
  const opened: Opened[] = [];
  const link = createWorkerStreamLink({
    instanceId: "w1",
    bounds: { clock, silenceMs: 1_000, startMs: 5_000 },
    captures,
    registry,
    screens: {
      openScreen: async (platform, device, settings) => {
        if (options.refuseWith !== undefined) throw options.refuseWith;
        const feed = new ScriptedFeed();
        opened.push({ deviceId: device.deviceId, feed, platform, settings });
        return feed;
      },
    },
    settings: SETTINGS,
  });
  return { captures, clock, link, opened, registry };
}

async function refusalOf(served: Promise<unknown>): Promise<StreamRefusalError> {
  const outcome = await served.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome, "the stream was expected to be refused").toBeInstanceOf(StreamRefusalError);
  return outcome as StreamRefusalError;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

async function opening(
  setupValue: ReturnType<typeof setup>,
  caller: StreamCaller = OPERATOR,
  signal = new AbortController().signal,
): Promise<{ served: Promise<CapturedStream>; feed: ScriptedFeed }> {
  const served = setupValue.link.serve(DEVICE, caller, signal);
  await flush();
  const feed = setupValue.opened.at(-1)?.feed;
  if (feed === undefined) throw new Error("no screen was opened");
  return { feed, served };
}

describe("the worker's stream link", () => {
  it("refuses a device it does not have with the answer every other route gives", async () => {
    const { link, opened } = setup();
    const refusal = await refusalOf(
      link.serve({ deviceId: "dev_nope" }, OPERATOR, new AbortController().signal),
    );
    expect([refusal.status, refusal.code]).toEqual([404, "UNKNOWN_DEVICE"]);
    expect(opened).toEqual([]);
  });

  it("answers an agent exactly as if the device did not exist, opening nothing", async () => {
    const { link, opened } = setup();
    const refusal = await refusalOf(link.serve(DEVICE, AGENT, new AbortController().signal));
    expect([refusal.status, refusal.code, refusal.message]).toEqual([
      404,
      "UNKNOWN_DEVICE",
      "Unknown device: dev_1",
    ]);
    expect(opened).toEqual([]);
  });

  it("opens the device's screen through its platform's driver, with the configured settings", async () => {
    const harness = setup();
    const { feed, served } = await opening(harness, OPERATOR);
    feed.meta();
    const stream = await served;
    expect(stream.meta).toEqual({ codec: "h264", fps: 30, height: 720, width: 330 });
    expect(
      harness.opened.map(({ deviceId, platform, settings }) => ({ deviceId, platform, settings })),
    ).toEqual([{ deviceId: "drv-dev_1", platform: "android", settings: SETTINGS }]);
  });

  it("refuses a device whose driver cannot stream it as not supported", async () => {
    const { link } = setup({ refuseWith: new ScreenNotSupportedError("A physical phone cannot") });
    const refusal = await refusalOf(link.serve(DEVICE, OPERATOR, new AbortController().signal));
    expect([refusal.status, refusal.code, refusal.message]).toEqual([
      415,
      "STREAM_NOT_SUPPORTED",
      "A physical phone cannot",
    ]);
  });

  it("refuses a capture that cannot run right now as unavailable", async () => {
    const { link } = setup({ refuseWith: new ScreenUnavailableError("No capture program") });
    const refusal = await refusalOf(link.serve(DEVICE, OPERATOR, new AbortController().signal));
    expect([refusal.status, refusal.code]).toEqual([503, "STREAM_UNAVAILABLE"]);
  });

  it("refuses, and closes the capture, when nothing is painted within the start bound", async () => {
    const harness = setup();
    const { feed, served } = await opening(harness);
    harness.clock.advance(5_000);
    const refusal = await refusalOf(served);
    expect([refusal.status, refusal.code]).toEqual([503, "STREAM_UNAVAILABLE"]);
    expect(feed.closes).toBe(1);
  });

  it("refuses with 409 DEVICE_NOT_RUNNING, and closes the capture, when the device stops while the capture is starting", async () => {
    const harness = setup();
    const { feed, served } = await opening(harness);
    await harness.captures.stopOnDevice("dev_1");
    feed.meta();
    const refusal = await refusalOf(served);
    expect([refusal.status, refusal.code]).toEqual([409, "DEVICE_NOT_RUNNING"]);
    expect(feed.closes).toBeGreaterThan(0);
    expect(await harness.captures.stopOnDevice("dev_1")).toBe(0);
  });

  it("closes a capture whose request was aborted before its first frame", async () => {
    const harness = setup();
    const abort = new AbortController();
    const { feed, served } = await opening(harness, OPERATOR, abort.signal);
    abort.abort();
    await refusalOf(served);
    expect(feed.closes).toBe(1);
    expect(await harness.captures.stopOnDevice("dev_1")).toBe(0);
  });

  it("closes a capture that finishes opening after its viewer already went away", async () => {
    let finishOpening!: (feed: ScriptedFeed) => void;
    const feed = new ScriptedFeed();
    const registry = new TestRegistry([{ id: "dev_1", platform: "android" }]);
    const captures = createCaptureRegistry();
    const link = createWorkerStreamLink({
      instanceId: "w1",
      bounds: { clock: new FakeClock(), silenceMs: 1_000, startMs: 5_000 },
      captures,
      registry,
      screens: { openScreen: () => new Promise((resolve) => (finishOpening = resolve)) },
      settings: SETTINGS,
    });
    const abort = new AbortController();
    const served = link.serve(DEVICE, OPERATOR, abort.signal);
    await flush();
    abort.abort();
    await flush();
    finishOpening(feed);
    feed.meta();
    await refusalOf(served);
    expect(feed.closes).toBe(1);
    expect(await captures.stopOnDevice("dev_1")).toBe(0);
  });

  it("gives two viewers of one device two captures: one leaving keeps the other, and the device stopping stops both", async () => {
    const harness = setup();
    const first = await opening(harness);
    first.feed.meta();
    const one = await first.served;
    const second = await opening(harness);
    second.feed.meta();
    const two = await second.served;
    expect(harness.opened).toHaveLength(2);
    await one.close();
    expect([first.feed.closes, second.feed.closes]).toEqual([1, 0]);
    await harness.captures.stopOnDevice("dev_1");
    expect([first.feed.closes, second.feed.closes]).toEqual([1, 1]);
    await two.close();
    expect(second.feed.closes).toBe(1);
  });

  it("tells the driver to stop opening when the device stops, and the stop waits for the open to settle", async () => {
    let finishOpening!: () => void;
    let openSignal: AbortSignal | undefined;
    const registry = new TestRegistry([{ id: "dev_1", platform: "android" }]);
    const captures = createCaptureRegistry();
    const link = createWorkerStreamLink({
      instanceId: "w1",
      bounds: { clock: new FakeClock(), silenceMs: 1_000, startMs: 5_000 },
      captures,
      registry,
      screens: {
        openScreen: (_platform, _device, _settings, signal) => {
          openSignal = signal;
          return new Promise((_resolve, reject) => {
            finishOpening = () => reject(new Error("stopped"));
          });
        },
      },
      settings: SETTINGS,
    });
    const served = link.serve(DEVICE, OPERATOR, new AbortController().signal);
    await flush();
    let ended = false;
    const stopping = captures.stopOnDevice("dev_1").then(() => (ended = true));
    await flush();
    expect(openSignal?.aborted).toBe(true);
    expect(ended).toBe(false);
    finishOpening();
    await stopping;
    expect((await refusalOf(served)).code).toBe("DEVICE_NOT_RUNNING");
  });

  it("a device that stops after the viewer left, while the open is still running, still waits for that open", async () => {
    let finishOpening!: () => void;
    const registry = new TestRegistry([{ id: "dev_1", platform: "android" }]);
    const captures = createCaptureRegistry();
    const link = createWorkerStreamLink({
      instanceId: "w1",
      bounds: { clock: new FakeClock(), silenceMs: 1_000, startMs: 5_000 },
      captures,
      registry,
      screens: {
        openScreen: () =>
          new Promise((_resolve, reject) => {
            finishOpening = () => reject(new Error("stopped"));
          }),
      },
      settings: SETTINGS,
    });
    const viewer = new AbortController();
    const served = link.serve(DEVICE, OPERATOR, viewer.signal);
    await flush();
    viewer.abort();
    await flush();
    let ended = false;
    const stopping = captures.stopOnDevice("dev_1").then(() => (ended = true));
    await flush();
    expect(ended).toBe(false);
    finishOpening();
    await stopping;
    await refusalOf(served);
    expect(await captures.stopOnDevice("dev_1")).toBe(0);
  });

  it("a device that stops under a viewer ends its picture", async () => {
    const harness = setup();
    const { feed, served } = await opening(harness);
    feed.meta();
    const stream = await served;
    expect(await harness.captures.stopOnDevice("dev_1")).toBe(1);
    expect(feed.closes).toBe(1);
    const reader = stream.body.getReader();
    await reader.read();
    expect((await reader.read()).done).toBe(true);
  });

  it("closing the stream releases its registration and closes the capture once", async () => {
    const harness = setup();
    const { feed, served } = await opening(harness);
    feed.meta();
    const stream = await served;
    await stream.close();
    await stream.close();
    expect(feed.closes).toBe(1);
    expect(await harness.captures.stopOnDevice("dev_1")).toBe(0);
  });
});
