import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  codecString,
  parseMeta,
  readStream,
  type StreamMeta,
  type StreamSink,
  type StreamStats,
  TAG,
} from "./stream";
import { SCREEN_FRAME_TAG } from "../../../src/core/index";

/**
 * why: the unit project has no browser, and the claims worth pinning here are what this reader hands
 * the two browser objects it drives. So these record exactly that instead of standing in for a
 * decoder's own behaviour, which is the browser's to have.
 */
let initialBacklog = 0;
let created: FakeDecoder[] = [];
let bitmaps: Blob[] = [];

const BROKEN = 0xee;

class FakeFrame {
  closed = 0;

  constructor(readonly displayHeight: number) {}

  close(): void {
    this.closed += 1;
  }
}

class FakeDecoder {
  readonly configs: { codec: string; description: Uint8Array }[] = [];
  readonly chunks: { data: Uint8Array; type: string }[] = [];
  resets = 0;
  closed = 0;
  backlog = initialBacklog;

  constructor(
    readonly callbacks: {
      output: (frame: FakeFrame) => void;
      error: (error: Error) => void;
    },
  ) {
    created.push(this);
  }

  get decodeQueueSize(): number {
    return this.backlog;
  }

  configure(config: { codec: string; description: Uint8Array }): void {
    this.configs.push({ codec: config.codec, description: config.description });
  }

  decode(chunk: { init: { data: Uint8Array; type: string } }): void {
    const { data, type } = chunk.init;
    this.chunks.push({ data, type });
    // why: a decoder spends a backlog on the frame it was asked for, which is the only thing the reader
    // can watch in order to decide to drop; the BROKEN payload is the one case where the fake reports
    // the failure a real decoder would report on its own.
    if (data[0] === BROKEN) this.callbacks.error(new Error("decoded to nothing"));
    if (this.backlog > 0) this.backlog -= 1;
    else this.callbacks.output(new FakeFrame(data.length));
  }

  reset(): void {
    this.resets += 1;
    this.backlog = 0;
  }

  close(): void {
    this.closed += 1;
  }
}

class Recorded {
  readonly images: { height: number; width: number }[] = [];
  readonly metas: StreamMeta[] = [];
  readonly stats: StreamStats[] = [];
  readonly ends: (string | undefined)[] = [];
  readonly frames: FakeFrame[] = [];

  sink(): StreamSink {
    return {
      onEnd: (reason) => {
        this.ends.push(reason);
      },
      onFrame: (frame) => {
        this.frames.push(frame as unknown as FakeFrame);
      },
      onImage: (image) => {
        this.images.push(image);
      },
      onMeta: (meta) => {
        this.metas.push(meta);
      },
      onStats: (stats) => {
        this.stats.push(stats);
      },
    };
  }

  get last(): StreamStats {
    const stats = this.stats.at(-1);
    if (stats === undefined) throw new Error("the reader never reported stats");
    return stats;
  }
}

/**
 * why: the envelope's promise is what is under test — a 4-byte big-endian length that covers the tag
 * byte as well as the payload, the tag, then the payload — so it is written out here in full rather
 * than hidden behind a helper a reader would have to trust.
 */
function frame(tag: number, payload: object | number[] | Uint8Array | string): Uint8Array {
  const bytes =
    typeof payload === "string"
      ? new TextEncoder().encode(payload)
      : payload instanceof Uint8Array
        ? payload
        : Array.isArray(payload)
          ? Uint8Array.from(payload)
          : new TextEncoder().encode(JSON.stringify(payload));
  const total = bytes.length + 1;
  const out = new Uint8Array(bytes.length + 5);
  out[0] = (total >>> 24) & 0xff;
  out[1] = (total >>> 16) & 0xff;
  out[2] = (total >>> 8) & 0xff;
  out[3] = total & 0xff;
  out[4] = tag;
  out.set(bytes, 5);
  return out;
}

function meta(
  payload: Record<string, unknown> = { codec: "h264", fps: 30, height: 4, width: 4 },
): Uint8Array {
  return frame(TAG.meta, payload);
}

function avcC(profile = 0x64, compatibility = 0x00, level = 0x1e): Uint8Array {
  return Uint8Array.from([0x01, profile, compatibility, level, 0xff, 0xe1]);
}

/**
 * why: one chunk per read, because that is what a streamed response does — a body is never handed over
 * in units of the encoder's frames.
 */
function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  const rest = [...chunks];
  return new ReadableStream({
    pull(controller) {
      const next = rest.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

function split(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const size of sizes) {
    out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
    at += size;
    if (at >= bytes.length) break;
  }
  if (at < bytes.length) out.push(bytes.subarray(at));
  return out;
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function read(chunks: readonly Uint8Array[], recorded = new Recorded()): Promise<Recorded> {
  await readStream(bodyOf(chunks), recorded.sink(), new AbortController().signal);
  return recorded;
}

function decoder(): FakeDecoder {
  const last = created.at(-1);
  if (last === undefined) throw new Error("the reader never built a decoder");
  return last;
}

function payloadOf(index: number): number[] {
  const chunk = decoder().chunks[index];
  if (chunk === undefined) throw new Error(`the reader handed over no chunk ${index}`);
  return [...chunk.data];
}

beforeEach(() => {
  initialBacklog = 0;
  created = [];
  bitmaps = [];
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(readonly init: { data: Uint8Array; type: string }) {}
    },
  );
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    bitmaps.push(blob);
    return { close: () => undefined, height: 6, width: 7 };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the envelope", () => {
  it("reads a stream that arrives one whole frame per read", async () => {
    const recorded = await read([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1, 2, 3]),
      frame(TAG.delta, [4, 5]),
    ]);

    expect(recorded.metas).toEqual([{ codec: "h264", fps: 30, height: 4, width: 4 }]);
    expect(decoder().configs).toEqual([{ codec: "avc1.64001e", description: avcC() }]);
    expect(decoder().chunks.map((chunk) => [...chunk.data])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(decoder().chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect(recorded.last.painted).toBe(2);
    expect(recorded.ends).toEqual([undefined]);
  });

  it("reads a frame whose four-byte length is cut across two reads", async () => {
    const whole = concatAll([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [7, 8, 9, 10]),
    ]);

    const recorded = await read(split(whole, [3]));

    expect(payloadOf(0)).toEqual([7, 8, 9, 10]);
    expect(recorded.last.error).toBeUndefined();
    expect(recorded.ends).toEqual([undefined]);
  });

  it("reads a frame whose payload is cut mid-way, arriving one byte per read", async () => {
    const whole = concatAll([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1, 2, 3]),
    ]);

    const recorded = await read(
      split(
        whole,
        [...whole].map(() => 1),
      ),
    );

    expect(payloadOf(0)).toEqual([1, 2, 3]);
    expect(recorded.last.error).toBeUndefined();
  });

  it("keeps the frame before a cut inside the next one, and hands over both", async () => {
    const both = concatAll([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1, 2, 3, 4]),
      ...split(frame(TAG.delta, [5, 6, 7]), [6]),
    ]);

    const recorded = await read([both]);

    expect(decoder().chunks.map((chunk) => [...chunk.data])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
    ]);
    expect(decoder().chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect(recorded.last.painted).toBe(2);
  });

  it("refuses a length larger than any frame the tool writes, and lets go of the body", async () => {
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      cancel: (reason) => {
        cancelled.push(reason);
      },
      start(controller) {
        controller.enqueue(Uint8Array.from([0xff, 0xff, 0xff, 0xff, TAG.keyframe, 0, 0, 0]));
      },
    });
    const recorded = new Recorded();

    await readStream(body, recorded.sink(), new AbortController().signal);

    expect(recorded.ends).toEqual(["The stream is not a frame envelope"]);
    // why: the request is what keeps the worker capturing, so a reader that gives up has to close it —
    // otherwise one broken byte leaves a device being filmed for a viewer that already left.
    expect(cancelled).toEqual(["The stream is not a frame envelope"]);
    expect(created).toHaveLength(0);
  });

  it("refuses a length that claims a frame with nothing in it", async () => {
    const recorded = await read([Uint8Array.from([0, 0, 0, 0, TAG.keyframe])]);

    expect(recorded.ends).toEqual(["The stream is not a frame envelope"]);
  });

  it("reads a stream whose meta frame is the first frame and reports the picture it names", async () => {
    const recorded = await read([
      frame(
        TAG.meta,
        '{"udid":"X","codec":"h264","width":330,"height":720,"fps":30,"deviceSet":"default"}',
      ),
      frame(TAG.description, avcC()),
    ]);

    expect(recorded.metas).toEqual([{ codec: "h264", fps: 30, height: 720, width: 330 }]);
  });

  it("refuses a body whose first frame is not JSON as what it is", async () => {
    const recorded = await read([frame(TAG.meta, "{not json")]);

    expect(recorded.ends).toEqual(["The stream's meta frame is not JSON"]);
  });

  it("refuses a codec no browser here can show, and says which", async () => {
    const recorded = await read([meta({ codec: "vp9", fps: 30, height: 4, width: 4 })]);

    expect(recorded.ends).toEqual(["This console cannot show a vp9 stream"]);
  });

  it("refuses a video byte that arrives before any parameter sets, rather than decoding it", async () => {
    const recorded = await read([meta(), frame(TAG.keyframe, [1, 2])]);

    expect(recorded.ends).toEqual(["The stream sent video before it sent its parameter sets"]);
    expect(created).toHaveLength(0);
  });

  it("configures the decoder again when the stream sends new parameter sets mid-picture", async () => {
    const recorded = await read([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1]),
      frame(TAG.description, avcC(0x4d, 0x03, 0x1f)),
      frame(TAG.keyframe, [2]),
    ]);

    expect(decoder().configs.map((config) => config.codec)).toEqual(["avc1.64001e", "avc1.4d031f"]);
    expect([...(decoder().configs[1]?.description.slice(1, 4) ?? [])]).toEqual([0x4d, 0x03, 0x1f]);
    // why: a decoder still holding frames of the old parameter sets has to be emptied first, or the
    // first frame after the change is decoded against the wrong picture.
    expect(decoder().resets).toBe(1);
    expect(recorded.last.error).toBeUndefined();
  });

  it("refuses bytes claimed to be parameter sets that are not an avcC, and names that", async () => {
    const recorded = await read([
      meta(),
      frame(TAG.description, Uint8Array.from([0x02, 0x64, 0x00, 0x1e])),
    ]);

    expect(recorded.ends).toEqual(["The stream's parameter sets are not an AVC description"]);
    expect(created).toHaveLength(0);
  });

  it("ends with the decoder's own words when it fails, and lets go of the body", async () => {
    const cancelled: unknown[] = [];
    const recorded = new Recorded();
    // why: the body is left open, as a live one is — what this has to prove is that a stream still
    // running gets closed, and a body that already ended has nothing left to close.
    const body = new ReadableStream<Uint8Array>({
      cancel: (reason) => {
        cancelled.push(reason);
      },
      start(controller) {
        controller.enqueue(meta());
        controller.enqueue(frame(TAG.description, avcC()));
        controller.enqueue(frame(TAG.keyframe, [BROKEN, 0, 0]));
      },
    });

    await readStream(body, recorded.sink(), new AbortController().signal);

    expect(recorded.ends).toEqual(["The decoder failed: decoded to nothing"]);
    expect(cancelled).toEqual(["The decoder failed: decoded to nothing"]);
    expect(recorded.last.error).toBe("The decoder failed: decoded to nothing");
  });

  it("closes the body when the viewer aborts, and ends once with nothing to show", async () => {
    const cancelled: unknown[] = [];
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel: (reason) => {
        cancelled.push(reason);
      },
      start(handle) {
        handle.enqueue(meta());
      },
    });
    const recorded = new Recorded();

    const reading = readStream(body, recorded.sink(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await reading;

    expect(cancelled).toHaveLength(1);
    expect(recorded.ends).toEqual([undefined]);
  });

  it("says nothing when the body fails at the moment the viewer goes away", async () => {
    const controller = new AbortController();
    let handle: ReadableStreamDefaultController<Uint8Array> | undefined;
    // why: a body that is aborted has usually already failed for the browser's own reason — a dropped
    // connection errors the stream as the tab goes away — and the viewer that asked to leave is not the
    // one to be told about it. The pull never settles, so the read is parked when both happen.
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<never>(() => undefined);
      },
      start(source) {
        handle = source;
        source.enqueue(meta());
      },
    });
    const recorded = new Recorded();

    const reading = readStream(body, recorded.sink(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    handle?.error(new Error("the connection dropped"));
    controller.abort();
    await reading;

    expect(recorded.ends).toEqual([undefined]);
    expect(recorded.last.error).toBeUndefined();
  });

  it("tells the viewer nothing more when the decoder fails after the stream is over", async () => {
    const recorded = await read([meta(), frame(TAG.description, avcC()), frame(TAG.keyframe, [1])]);

    // why: a decoder returns the frame it was holding on its own time, which can be after the body
    // ended; a pane told twice shows a reason that was already replaced.
    decoder().callbacks.error(new Error("late"));

    expect(recorded.ends).toEqual([undefined]);
    expect(recorded.last.error).toBeUndefined();
  });

  it("reports the rate of the last two seconds, so a quiet minute does not hide a fast swipe", async () => {
    let at = 0;
    const chunks: Uint8Array[] = [meta({ codec: "mjpeg", fps: 30, height: 4, width: 4 })];
    const times: number[] = [0];
    // why: one still, then a minute of nothing, then thirty stills within one second and one more
    // 0.9 s later. The lifetime average is about half a frame a second; the last two seconds hold 31
    // frames, 15.5 a second; a one- or a three-second window gives another figure.
    chunks.push(frame(TAG.delta, [0xff, 0xd8, 1]));
    times.push(0);
    // why: a still is counted once it is painted, which is after the next read; an `alive` frame in
    // the quiet minute is that next read, so the lone still lands well outside the window.
    chunks.push(frame(TAG.alive, []));
    times.push(30_000);
    for (let index = 0; index < 30; index += 1) {
      chunks.push(frame(TAG.delta, [0xff, 0xd8, index]));
      times.push(60_000 + (index * 1000) / 30);
    }
    chunks.push(frame(TAG.delta, [0xff, 0xd8, 0xee]));
    times.push(61_900);
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const chunk = chunks[next];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        at = times[next] ?? at;
        next += 1;
        controller.enqueue(chunk);
      },
    });
    const recorded = new Recorded();
    await readStream(body, recorded.sink(), new AbortController().signal, () => at);
    expect(recorded.last.painted).toBe(32);
    expect(recorded.last.framesPerSecond).toBeCloseTo(15.5, 5);
  });

  it("reports the bytes read and the frames painted as rates", async () => {
    const whole = concatAll([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1, 2, 3, 4, 5, 6, 7, 8]),
    ]);

    const recorded = await read([whole]);

    const stats = recorded.last;
    expect(stats.fed).toBe(1);
    expect(stats.painted).toBe(1);
    expect(stats.dropped).toBe(0);
    // why: how long the reads took is the browser's, so the claim is the arithmetic the two figures
    // have to agree on: kilobits of every byte of the envelope, over the span they took.
    expect(stats.kilobitsPerSecond).toBeGreaterThanOrEqual((whole.length * 8) / 1000);
    expect(stats.framesPerSecond).toBeGreaterThan(0);
  });
});

describe("a decoder that falls behind", () => {
  it("stops handing deltas over once the queue is over the bound and waits for a keyframe", async () => {
    initialBacklog = 20;

    const recorded = await read([
      meta(),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1]),
      frame(TAG.delta, [2]),
      frame(TAG.delta, [3]),
      frame(TAG.keyframe, [4]),
      frame(TAG.delta, [5]),
    ]);

    // why: the keyframe that filled the queue is the last frame the decoder was given, the two deltas
    // behind it are the ones refused, and the picture only resumes at the next keyframe.
    expect(decoder().chunks.map((chunk) => [...chunk.data])).toEqual([[1], [4], [5]]);
    expect(decoder().resets).toBe(1);
    expect(decoder().configs.map((config) => config.codec)).toEqual(["avc1.64001e", "avc1.64001e"]);
    expect(recorded.last.dropped).toBe(3);
    expect(recorded.last.error).toBeUndefined();
  });
});

describe("a stream carried as stills", () => {
  it("paints each delta as a JPEG and never builds a decoder", async () => {
    const first = Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const second = Uint8Array.from([0xff, 0xd8, 3, 4, 0xff, 0xd9]);

    const recorded = await read([
      meta({ codec: "mjpeg", fps: 12, height: 6, width: 7 }),
      frame(TAG.delta, first),
      frame(TAG.delta, second),
    ]);

    expect(created).toHaveLength(0);
    expect(bitmaps.map((blob) => blob.size)).toEqual([first.length, second.length]);
    expect(recorded.last.painted).toBe(2);
    expect(recorded.metas).toEqual([{ codec: "mjpeg", fps: 12, height: 6, width: 7 }]);
  });

  it("paints a still seed frame for a video stream as well as the frames after it", async () => {
    const seed = Uint8Array.from([0xff, 0xd8, 9, 0xff, 0xd9]);

    const recorded = await read([
      meta(),
      frame(TAG.seed, seed),
      frame(TAG.description, avcC()),
      frame(TAG.keyframe, [1]),
    ]);

    expect(bitmaps.map((blob) => blob.size)).toEqual([seed.length]);
    expect(decoder().chunks).toHaveLength(1);
    expect(recorded.last.painted).toBe(2);
  });
});

describe("the codec string an avcC describes", () => {
  it("keeps a parameter byte's leading zero, which is what makes the name one a browser knows", () => {
    expect(codecString(avcC(0x64, 0x00, 0x1e))).toBe("avc1.64001e");
  });

  it("writes each of the three parameters as exactly two digits", () => {
    expect(codecString(avcC(0x0a, 0x0b, 0x0c))).toBe("avc1.0a0b0c");
    expect(codecString(avcC(0x6d, 0xc8, 0x2a))).toBe("avc1.6dc82a");
    expect(codecString(avcC(0x00, 0x00, 0x00))).toBe("avc1.000000");
  });

  it("has no name for bytes that are not an avcC", () => {
    expect(codecString(Uint8Array.from([0x02, 0x64, 0x00, 0x1e]))).toBeUndefined();
    expect(codecString(Uint8Array.from([0x01, 0x64, 0x00]))).toBeUndefined();
    expect(codecString(new Uint8Array(0))).toBeUndefined();
  });
});

describe("what a meta frame claims", () => {
  it("takes the picture's size and rate as the tool wrote them", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ codec: "h264", fps: 24, height: 720, width: 330 }),
    );

    expect(parseMeta(payload)).toEqual({
      meta: { codec: "h264", fps: 24, height: 720, width: 330 },
    });
  });

  it("reads a size or rate the frame does not carry as zero rather than guessing one", () => {
    expect(parseMeta(new TextEncoder().encode(JSON.stringify({ codec: "mjpeg" })))).toEqual({
      meta: { codec: "mjpeg", fps: 0, height: 0, width: 0 },
    });
  });

  it("reads a size the frame gave as something else as zero too", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ codec: "h264", height: null, width: "330" }),
    );

    expect(parseMeta(payload)).toEqual({
      meta: { codec: "h264", fps: 0, height: 0, width: 0 },
    });
  });
});

describe("the envelope's tags", () => {
  it("are the tags every capture writes, so a frame the daemon carries is the frame this reads", () => {
    expect(TAG).toEqual(SCREEN_FRAME_TAG);
  });
});
