import { describe, expect, it } from "vitest";

import { encodeScreenFrame, encodeScreenMeta, SCREEN_FRAME_TAG } from "../core/index.js";
import { createBroadcast } from "./broadcast.js";
import type { CapturedStream } from "./feed.js";

const META = { codec: "h264", fps: 30, height: 720, width: 330 } as const;

function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const calls = { closes: 0 };
  const stream: CapturedStream = {
    body: new ReadableStream<Uint8Array>({ start: (c) => (controller = c) }),
    close: async () => {
      calls.closes += 1;
    },
    meta: META,
  };
  return { calls, controller: () => controller, stream };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// why: `viewers`, `done` and a viewer's `close` are the broadcast's own surface, which the worker's
// stream shows only through what it does with them; here they are checked one by one.
describe("createBroadcast", () => {
  it("counts its viewers, closes the source once when the last leaves by any of its three ways, and settles done", async () => {
    const { calls, controller, stream } = source();
    const broadcast = createBroadcast(stream);
    controller().enqueue(encodeScreenMeta(META));
    const abort = new AbortController();
    const byAbort = broadcast.join(abort.signal);
    const byClose = broadcast.join(new AbortController().signal);
    const byCancel = broadcast.join(new AbortController().signal);
    expect(byAbort.meta).toEqual(META);
    expect(broadcast.viewers).toBe(3);

    abort.abort();
    await byClose.close();
    await byClose.close();
    expect(broadcast.viewers).toBe(1);
    expect(calls.closes).toBe(0);

    await byCancel.body.cancel();
    await broadcast.done;
    expect(broadcast.viewers).toBe(0);
    expect(calls.closes).toBe(1);
  });

  it("ends every body after what is queued when the source ends, and settles done", async () => {
    const { calls, controller, stream } = source();
    const broadcast = createBroadcast(stream);
    controller().enqueue(encodeScreenMeta(META));
    controller().enqueue(encodeScreenFrame(SCREEN_FRAME_TAG.keyframe, Uint8Array.of(1)));
    const viewer = broadcast.join(new AbortController().signal);
    await flush();
    controller().close();
    await flush();
    const reader = viewer.body.getReader();
    const tags = [];
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      tags.push(step.value[4]);
    }
    expect(tags).toEqual([SCREEN_FRAME_TAG.meta, SCREEN_FRAME_TAG.keyframe]);
    await broadcast.done;
    expect(calls.closes).toBe(1);
  });
});
