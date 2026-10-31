// why: the channel framing of a two-way relay (ADR 0049 section 5): `[len u32 big-endian][tag u8][payload]`,
// `len` counting the tag and the payload. Only the tunnel module encodes and reads it; the relay moves bytes.
import { TUNNEL_MAX_DATA_BYTES } from "../contract/index.js";

// why: a tunnel message is `[tag][conn u32][payload]` with a payload of at most one DATA's bytes, and the channel carries one message per frame.
export const MAX_TUNNEL_MESSAGE_BYTES = 5 + TUNNEL_MAX_DATA_BYTES;

export interface ChannelFrame {
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
): AsyncGenerator<ChannelFrame, void, void> {
  const reader = readable.getReader();
  let buffer: Uint8Array = new Uint8Array();
  try {
    for (;;) {
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.length).getUint32(0);
        if (length < 1 || length > MAX_TUNNEL_MESSAGE_BYTES + 1) return;
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
