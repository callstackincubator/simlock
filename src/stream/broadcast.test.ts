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
  it("counts its viewers, closes the source once when the last leaves by abort, close or cancel, and settles done", async () => {
    for (const last of ["abort", "close", "cancel"] as const) {
      const { calls, controller, stream } = source();
      const broadcast = createBroadcast(stream);
      controller().enqueue(encodeScreenMeta(META));
      const abort = new AbortController();
      const ways = {
        abort: broadcast.join(abort.signal),
        cancel: broadcast.join(new AbortController().signal),
        close: broadcast.join(new AbortController().signal),
      };
      expect(ways.abort.meta, last).toEqual(META);
      expect(broadcast.viewers, last).toBe(3);

      const leave = {
        abort: async () => abort.abort(),
        cancel: () => ways.cancel.body.cancel(),
        close: async () => {
          await ways.close.close();
          await ways.close.close();
        },
      };
      const others = (["abort", "close", "cancel"] as const).filter((way) => way !== last);
      for (const way of others) await leave[way]();
      expect(broadcast.viewers, last).toBe(1);
      expect(calls.closes, last).toBe(0);

      await leave[last]();
      await broadcast.done;
      expect(broadcast.viewers, last).toBe(0);
      expect(calls.closes, last).toBe(1);
    }
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
