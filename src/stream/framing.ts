import { SCREEN_FRAME_HEADER_BYTES, SCREEN_FRAME_TAG, type ScreenMeta } from "../core/index.js";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// why: a size is a claim from a program or a worker, and both end up in a browser's decoder
// configuration and a response header; anything past this is not a screen any device has.
const MAX_SIDE = 16_384;
const MAX_FPS = 240;

export interface MetaFrame {
  readonly meta: ScreenMeta;
  readonly bytes: Uint8Array;
}

export class MetaFrameScanner {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): MetaFrame | undefined {
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      throw new Error("The screen capture wrote no meta frame before an oversized frame");
    }
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;

    if (this.#buffer.length < SCREEN_FRAME_HEADER_BYTES) return undefined;
    const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getUint32(0);
    const total = SCREEN_FRAME_HEADER_BYTES + length - 1;
    if (length < 1 || total > MAX_FRAME_BYTES) {
      throw new Error("The screen capture's output is not a frame envelope");
    }
    // why: a frame ahead of the meta frame means a capture that broke the one promise the envelope
    // makes -- meta first -- so the stream is refused rather than decoded blind.
    if (this.#buffer[4] !== SCREEN_FRAME_TAG.meta) {
      throw new Error("The screen capture's stream does not begin with a meta frame");
    }
    if (this.#buffer.length < total) return undefined;
    const meta = readScreenMeta(this.#buffer.subarray(SCREEN_FRAME_HEADER_BYTES, total));
    return { bytes: this.#buffer.slice(0, total), meta };
  }
}

function readScreenMeta(payload: Uint8Array): ScreenMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("The screen capture's meta frame is not JSON");
  }
  const fields =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return checkedMeta(fields["codec"], fields["width"], fields["height"], fields["fps"]);
}

// why: one check for a meta frame read from a capture and for the headers a gateway reads from a
// worker, so the two doors cannot disagree about what a picture may claim to be.
export function checkedMeta(
  codec: unknown,
  width: unknown,
  height: unknown,
  fps: unknown,
): ScreenMeta {
  if (codec !== "h264" && codec !== "mjpeg") {
    throw new Error(`The screen capture names a codec this stream cannot carry: ${String(codec)}`);
  }
  return {
    codec,
    fps: bounded(fps, 0, MAX_FPS, "fps"),
    height: bounded(height, 1, MAX_SIDE, "height"),
    width: bounded(width, 1, MAX_SIDE, "width"),
  };
}

function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`The screen capture's ${name} is not a size a screen has: ${String(value)}`);
  }
  return value;
}
