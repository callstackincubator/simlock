import { describe, expect, it } from "vitest";

import { SCREEN_FRAME_TAG as CAPTURE_TAG } from "../core/index.js";
import { checkedMeta, FrameSplitter, MAX_FRAME_BYTES, MetaFrameScanner } from "./framing.js";

const META = { codec: "h264", deviceSet: "/set", fps: 30, height: 720, udid: "UDID", width: 330 };

function frame(tag: number, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(5);
  new DataView(head.buffer).setUint32(0, payload.length + 1);
  head[4] = tag;
  return Uint8Array.from([...head, ...payload]);
}

function metaFrame(payload: unknown = META): Uint8Array {
  return frame(CAPTURE_TAG.meta, new TextEncoder().encode(JSON.stringify(payload)));
}

describe("MetaFrameScanner", () => {
  it("finds a meta frame only once its last byte has arrived", () => {
    const bytes = metaFrame();
    const scanner = new MetaFrameScanner();
    const found = [];
    // why: one byte at a time, because a header split across reads is what a pipe actually does, and a
    // scanner that reads a length it has not fully received acts on bytes that are not there yet.
    for (const byte of bytes) {
      found.push(scanner.push(Uint8Array.from([byte])));
    }
    expect(found.slice(0, -1).every((step) => step === undefined)).toBe(true);
    expect(found.at(-1)?.meta).toEqual({ codec: "h264", fps: 30, height: 720, width: 330 });
    expect(found.at(-1)?.bytes).toEqual(bytes);
  });

  it("refuses a stream that puts a video frame before the meta frame", () => {
    const scanner = new MetaFrameScanner();
    // why: the meta frame is the one promise the envelope makes, and a decoder configured from a header
    // that never arrived would fail later and further away from the cause.
    expect(() => scanner.push(frame(CAPTURE_TAG.keyframe, new Uint8Array([1, 2, 3])))).toThrow(
      /does not begin with a meta frame/u,
    );
    expect(() => scanner.push(frame(CAPTURE_TAG.description, new Uint8Array([1])))).toThrow(
      /does not begin with a meta frame/u,
    );
  });

  it("refuses a header whose length is not a frame", () => {
    for (const length of [0, MAX_FRAME_BYTES + 10, 0xffff_ffff]) {
      const head = new Uint8Array(5);
      new DataView(head.buffer).setUint32(0, length);
      head[4] = CAPTURE_TAG.meta;
      expect(() => new MetaFrameScanner().push(head)).toThrow(/not a frame envelope/u);
    }
  });

  it("refuses a meta frame whose payload is not JSON rather than reporting a stream with no size", () => {
    const scanner = new MetaFrameScanner();
    // why: a size of zero would answer a response with headers saying so, and the viewer would sit on a
    // stream it can never decode; the tool's own log is where that failure is explained.
    expect(() => scanner.push(frame(CAPTURE_TAG.meta, new TextEncoder().encode("<html>")))).toThrow(
      /meta frame is not JSON/u,
    );
  });

  it("reads an mjpeg meta as mjpeg", () => {
    const scanner = new MetaFrameScanner();
    const found = scanner.push(metaFrame({ codec: "mjpeg", fps: 5, height: 720, width: 330 }));
    expect(found?.meta).toEqual({ codec: "mjpeg", fps: 5, height: 720, width: 330 });
  });

  it("refuses a meta frame that leaves out the size rather than reporting a stream with no size", () => {
    expect(() => new MetaFrameScanner().push(metaFrame({ codec: "h264", fps: 30 }))).toThrow(
      /is not a size a screen has/u,
    );
  });
});

describe("checkedMeta", () => {
  it("refuses a codec the stream cannot carry instead of calling it h264", () => {
    expect(() => checkedMeta("vp9", 330, 720, 30)).toThrow(/codec this stream cannot carry: vp9/u);
  });

  it("refuses a size no screen has", () => {
    expect(() => checkedMeta("h264", 330, 1_000_000, 30)).toThrow(/height/u);
    expect(() => checkedMeta("h264", 0, 720, 30)).toThrow(/width/u);
    expect(() => checkedMeta("h264", 330.5, 720, 30)).toThrow(/width/u);
    expect(() => checkedMeta("h264", 330, 720, -1)).toThrow(/fps/u);
  });
});

// why: the splitter is pure logic with many byte-level cases (split headers, several frames to a chunk,
// bounds), which a stream through the worker cannot lay out one by one.
describe("FrameSplitter", () => {
  it("splits chunks into whole frames, however the bytes arrive, and reads nothing but each frame's length and tag", () => {
    const frames = [
      metaFrame(),
      frame(CAPTURE_TAG.description, new Uint8Array([7])),
      frame(CAPTURE_TAG.keyframe, new Uint8Array(300).fill(1)),
      frame(CAPTURE_TAG.alive, new Uint8Array(0)),
    ];
    const stream = Uint8Array.from(frames.flatMap((bytes) => [...bytes]));
    const sizes = [1, 2, 3, 7, stream.length];
    for (const size of sizes) {
      const splitter = new FrameSplitter();
      const got = [];
      for (let offset = 0; offset < stream.length; offset += size) {
        got.push(...splitter.push(stream.subarray(offset, offset + size)));
      }
      expect(
        got.map((found) => found.tag),
        `chunks of ${String(size)}`,
      ).toEqual([
        CAPTURE_TAG.meta,
        CAPTURE_TAG.description,
        CAPTURE_TAG.keyframe,
        CAPTURE_TAG.alive,
      ]);
      expect(got.map((found) => found.bytes)).toEqual(frames);
    }
  });

  it("refuses an oversized frame, an empty length and a first frame that is not a meta frame, each with its message", () => {
    const header = (length: number, tag: number) => {
      const bytes = new Uint8Array(5);
      new DataView(bytes.buffer).setUint32(0, length);
      bytes[4] = tag;
      return bytes;
    };
    const cases: [string, Uint8Array[], string][] = [
      [
        "over the bound",
        [metaFrame(), header(MAX_FRAME_BYTES, CAPTURE_TAG.keyframe)],
        `The screen stream sent a frame of ${String(MAX_FRAME_BYTES + 4)} bytes, over the 8388608 a frame may be`,
      ],
      [
        "a length of 0",
        [metaFrame(), new Uint8Array([0, 0, 0, 0, 2])],
        "The screen stream's output is not a frame envelope",
      ],
      [
        "a first frame that is not meta",
        [frame(CAPTURE_TAG.keyframe, new Uint8Array([1]))],
        "The screen stream does not begin with a meta frame",
      ],
    ];
    for (const [label, chunks, message] of cases) {
      const splitter = new FrameSplitter();
      expect(() => chunks.forEach((chunk) => splitter.push(chunk)), label).toThrow(message);
    }
    const exact = new FrameSplitter();
    expect(
      () =>
        exact.push(
          Uint8Array.from([...metaFrame(), ...header(MAX_FRAME_BYTES - 4, CAPTURE_TAG.keyframe)]),
        ),
      "a frame of exactly the bound",
    ).not.toThrow();
    const oneOver = new FrameSplitter();
    expect(
      () =>
        oneOver.push(
          Uint8Array.from([...metaFrame(), ...header(MAX_FRAME_BYTES - 3, CAPTURE_TAG.keyframe)]),
        ),
      "a frame of one byte over the bound",
    ).toThrow(`over the 8388608 a frame may be`);
  });
});
