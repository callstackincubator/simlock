import { describe, expect, it } from "vitest";

import { CAPTURE_TAG, MAX_FRAME_BYTES, MetaFrameScanner } from "./framing.js";

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

  it("reports the meta frame it returned as exactly the bytes that frame occupies", () => {
    const bytes = metaFrame();
    const scanner = new MetaFrameScanner();
    const found = scanner.push(bytes);
    expect(found?.bytes.byteLength).toBe(bytes.byteLength);
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

  it("reads an mjpeg meta as mjpeg and defaults a size it was not told to zero", () => {
    const scanner = new MetaFrameScanner();
    const found = scanner.push(metaFrame({ codec: "mjpeg" }));
    expect(found?.meta).toEqual({ codec: "mjpeg", fps: 0, height: 0, width: 0 });
  });
});
