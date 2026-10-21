import { describe, expect, it } from "vitest";

import { encodeScreenMeta } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import { readScreenFeed } from "./feed.js";
import { ScriptedFeed } from "./test-fixtures.js";

const BOUNDS = { silenceMs: 1_000, startMs: 5_000 };

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("readScreenFeed", () => {
  it("answers with the meta frame and replays it, and the bytes that came with it, at the head of the body", async () => {
    const feed = new ScriptedFeed();
    const meta = encodeScreenMeta({ codec: "h264", fps: 30, height: 720, width: 330 });
    feed.write(Uint8Array.from([...meta, 9, 9]));
    const stream = await readScreenFeed(feed, { clock: new FakeClock(), ...BOUNDS });
    const reader = stream.body.getReader();
    expect([...((await reader.read()).value ?? [])]).toEqual([...meta, 9, 9]);
    expect(stream.meta.width).toBe(330);
  });

  it("fails before the first frame only at the start bound, not the shorter silence bound", async () => {
    const clock = new FakeClock();
    const feed = new ScriptedFeed();
    const outcome = readScreenFeed(feed, { clock, ...BOUNDS }).then(
      () => "answered",
      (error: unknown) => (error as Error).message,
    );
    clock.advance(BOUNDS.silenceMs);
    await flush();
    feed.meta();
    expect(await outcome).toBe("answered");
  });

  it("refuses a capture that ends before it writes a frame", async () => {
    const feed = new ScriptedFeed();
    const outcome = readScreenFeed(feed, { clock: new FakeClock(), ...BOUNDS });
    feed.end();
    await expect(outcome).rejects.toThrow(/ended before it wrote a frame/u);
  });

  it("keeps a picture that keeps arriving within the silence bound", async () => {
    const clock = new FakeClock();
    const feed = new ScriptedFeed();
    feed.meta();
    const stream = await readScreenFeed(feed, { clock, ...BOUNDS });
    const reader = stream.body.getReader();
    await reader.read();
    for (let frame = 0; frame < 3; frame += 1) {
      const next = reader.read();
      await flush();
      clock.advance(BOUNDS.silenceMs - 1);
      feed.keyframe();
      expect((await next).done).toBe(false);
    }
    expect(feed.closes).toBe(0);
  });

  it("closes the capture when the viewer cancels the body", async () => {
    const feed = new ScriptedFeed();
    feed.meta();
    const stream = await readScreenFeed(feed, { clock: new FakeClock(), ...BOUNDS });
    await stream.body.cancel();
    expect(feed.closes).toBe(1);
  });
});
