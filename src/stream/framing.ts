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

export function readScreenMeta(payload: Uint8Array): ScreenMeta {
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

export interface Frame {
  readonly tag: number;
  // why: the whole frame, header included, so a viewer is handed bytes it can write as they are.
  readonly bytes: Uint8Array;
}

// why: a stream is read here only as far as each frame's length and tag, so a frame can be handed to
// a viewer or dropped without anyone reading a picture's bytes.
export class FrameSplitter {
  #head = new Uint8Array(SCREEN_FRAME_HEADER_BYTES);
  #headFilled = 0;
  #frame: Uint8Array | undefined;
  #filled = 0;
  #started = false;

  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#frame === undefined) {
        const take = Math.min(SCREEN_FRAME_HEADER_BYTES - this.#headFilled, chunk.length - offset);
        this.#head.set(chunk.subarray(offset, offset + take), this.#headFilled);
        this.#headFilled += take;
        offset += take;
        if (this.#headFilled < SCREEN_FRAME_HEADER_BYTES) break;
        this.#frame = this.#startFrame();
      }
      const take = Math.min(this.#frame.length - this.#filled, chunk.length - offset);
      this.#frame.set(chunk.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === this.#frame.length) {
        frames.push({ bytes: this.#frame, tag: this.#frame[4] ?? 0 });
        this.#frame = undefined;
      }
    }
    return frames;
  }

  #startFrame(): Uint8Array {
    const length = new DataView(this.#head.buffer).getUint32(0);
    const total = SCREEN_FRAME_HEADER_BYTES + length - 1;
    this.#headFilled = 0;
    if (length < 1) throw new Error("The screen stream's output is not a frame envelope");
    if (total > MAX_FRAME_BYTES) {
      throw new Error(
        `The screen stream sent a frame of ${String(total)} bytes, over the ${String(MAX_FRAME_BYTES)} a frame may be`,
      );
    }
    if (!this.#started && this.#head[4] !== SCREEN_FRAME_TAG.meta) {
      throw new Error("The screen stream does not begin with a meta frame");
    }
    this.#started = true;
    const frame = new Uint8Array(total);
    frame.set(this.#head);
    this.#filled = SCREEN_FRAME_HEADER_BYTES;
    return frame;
  }
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
