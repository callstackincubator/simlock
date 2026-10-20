import { ByteQueue } from "./byte-queue.js";

// why: "h264" as a big-endian u32 -- the server writes its codec's id as the stream's first four bytes,
// and an id of 0 or 1 instead says it disabled the stream or failed to configure it.
export const SCRCPY_CODEC_H264 = 0x68323634;
const SCRCPY_STREAM_DISABLED = 0;
const SCRCPY_STREAM_CONFIG_ERROR = 1;

const CODEC_ID_BYTES = 4;
const PACKET_HEADER_BYTES = 12;
const SESSION_FLAG = 0x80000000;
const CONFIG_FLAG = 0x40000000;
const KEY_FLAG = 0x20000000;
const PTS_HIGH_MASK = 0x1fffffff;

// why: the browser that reads this stream refuses a frame over 8 MiB, so a packet that claims more is a
// desynced stream, not a big picture; the bound also caps what one half-read packet can hold in memory.
export const MAX_SCRCPY_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_SIDE = 16_384;

export type ScrcpyVideoEvent =
  | { readonly kind: "session"; readonly width: number; readonly height: number }
  | {
      readonly kind: "media";
      readonly config: boolean;
      readonly key: boolean;
      readonly pts: number;
      readonly payload: Uint8Array;
    };

export class ScrcpyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrcpyProtocolError";
  }
}

export class ScrcpyVideoParser {
  readonly #queue = new ByteQueue();
  #codecRead = false;
  #pending:
    | {
        readonly config: boolean;
        readonly key: boolean;
        readonly pts: number;
        readonly size: number;
      }
    | undefined;

  push(chunk: Uint8Array): ScrcpyVideoEvent[] {
    this.#queue.push(chunk);
    const events: ScrcpyVideoEvent[] = [];
    for (;;) {
      const event = this.#next();
      if (event === undefined) return events;
      if (event !== "codec") events.push(event);
    }
  }

  // fallow-ignore-next-line complexity -- one branch per packet kind scrcpy's video socket carries.
  #next(): ScrcpyVideoEvent | "codec" | undefined {
    if (!this.#codecRead) {
      if (this.#queue.length < CODEC_ID_BYTES) return undefined;
      this.#readCodec(new DataView(this.#queue.take(CODEC_ID_BYTES).buffer).getUint32(0));
      return "codec";
    }
    if (this.#pending !== undefined) {
      if (this.#queue.length < this.#pending.size) return undefined;
      const { config, key, pts, size } = this.#pending;
      this.#pending = undefined;
      return { config, key, kind: "media", payload: this.#queue.take(size), pts };
    }
    if (this.#queue.length < PACKET_HEADER_BYTES) return undefined;
    const header = new DataView(this.#queue.take(PACKET_HEADER_BYTES).buffer);
    const high = header.getUint32(0);
    if ((high & SESSION_FLAG) !== 0) {
      const width = header.getUint32(4);
      const height = header.getUint32(8);
      if (width === 0 || height === 0 || width > MAX_VIDEO_SIDE || height > MAX_VIDEO_SIDE) {
        throw new ScrcpyProtocolError(
          `The screen server announced a ${String(width)}x${String(height)} picture`,
        );
      }
      return { height, kind: "session", width };
    }
    const size = header.getUint32(8);
    if (size > MAX_SCRCPY_PACKET_BYTES) {
      throw new ScrcpyProtocolError(`The screen server sent a ${String(size)}-byte packet`);
    }
    this.#pending = {
      config: (high & CONFIG_FLAG) !== 0,
      key: (high & KEY_FLAG) !== 0,
      pts: (high & PTS_HIGH_MASK) * 2 ** 32 + header.getUint32(4),
      size,
    };
    return this.#next();
  }

  #readCodec(id: number): void {
    this.#codecRead = true;
    if (id === SCRCPY_CODEC_H264) return;
    if (id === SCRCPY_STREAM_DISABLED) {
      throw new ScrcpyProtocolError("The screen server disabled its video stream");
    }
    if (id === SCRCPY_STREAM_CONFIG_ERROR) {
      throw new ScrcpyProtocolError("The screen server could not configure its video stream");
    }
    throw new ScrcpyProtocolError(`The screen server chose codec 0x${id.toString(16)}, not H.264`);
  }
}
