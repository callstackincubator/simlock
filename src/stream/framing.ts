export const CAPTURE_TAG = {
  description: 0x01,
  keyframe: 0x02,
  delta: 0x03,
  seed: 0x04,
  meta: 0x05,
} as const;

const HEADER_BYTES = 5;

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface CaptureMeta {
  readonly codec: "h264" | "mjpeg";
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export interface MetaFrame {
  readonly meta: CaptureMeta;
  readonly bytes: Uint8Array;
}

export class MetaFrameScanner {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): MetaFrame | undefined {
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      throw new Error("The screen capture tool wrote no meta frame before an oversized frame");
    }
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;

    for (;;) {
      if (this.#buffer.length < HEADER_BYTES) return undefined;
      const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getUint32(0);
      const total = HEADER_BYTES + length - 1;
      if (length < 1 || total > MAX_FRAME_BYTES) {
        throw new Error("The screen capture tool's output is not a frame envelope");
      }
      if (this.#buffer.length < total) return undefined;
      if (this.#buffer[4] === CAPTURE_TAG.meta) {
        const meta = parseMeta(this.#buffer.subarray(HEADER_BYTES, total));
        if (meta === undefined) {
          throw new Error("The screen capture tool's meta frame is not JSON");
        }
        return { bytes: this.#buffer.slice(0, total), meta };
      }
      // why: a frame ahead of the meta frame means a tool that broke the one promise the envelope
      // makes -- write the meta first -- so the stream is refused rather than decoded blind.
      throw new Error("The screen capture tool's stream does not begin with a meta frame");
    }
  }
}

function parseMeta(payload: Uint8Array): CaptureMeta | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    const number = (key: string) => (typeof parsed[key] === "number" ? parsed[key] : 0);
    return {
      codec: parsed["codec"] === "mjpeg" ? "mjpeg" : "h264",
      fps: number("fps"),
      height: number("height"),
      width: number("width"),
    };
  } catch {
    return undefined;
  }
}
