// why: the channel framing of a two-way relay (ADR 0049 section 5): `[len u32 big-endian][tag u8][payload]`,
// `len` counting the tag and the payload. Only the input module encodes and reads it; the relay moves bytes.
import { MAX_INPUT_MESSAGE_BYTES } from "../core/index.js";

// why: the two channel-only tags: a heartbeat the worker sends while it is alive, and the worker's close
// `{code, reason}`; neither reaches a client, and a client's tags are serve-sim's.
export const CHANNEL_TAG = { close: 0xf1, heartbeat: 0xf0 } as const;

export interface InputFrame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(tag: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1);
  frame[4] = tag;
  frame.set(payload, 5);
  return frame;
}

function joined(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const all = new Uint8Array(head.length + tail.length);
  all.set(head);
  all.set(tail, head.length);
  return all;
}

// why: ends quietly on a frame longer than a message may be, a stream that ends mid-frame and a stream
// that errors, so a peer that breaks the framing or drops is the same as one that went away.
export async function* readFrames(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<InputFrame, void, void> {
  const reader = readable.getReader();
  let buffer: Uint8Array = new Uint8Array();
  try {
    for (;;) {
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.length).getUint32(0);
        if (length < 1 || length > MAX_INPUT_MESSAGE_BYTES + 1) return;
        if (buffer.length < 4 + length) break;
        yield { payload: buffer.slice(5, 4 + length), tag: buffer[4] ?? 0 };
        buffer = buffer.subarray(4 + length);
      }
      const step = await reader.read().catch(() => undefined);
      if (step === undefined || step.done) return;
      buffer = joined(buffer, step.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
