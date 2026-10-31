// why: the frames of a lease's tunnel socket (ADR 0054 section 3). They are not daemon-contract
// operations, but the worker's module and the CLI's `simlock tunnel` must agree on every byte, so the
// codec sits here, imported by both: one binary message is `[tag u8][conn u32 big-endian][payload]`.
export const TUNNEL_TAG = {
  data: 0x03,
  hello: 0x01,
  open: 0x02,
  ready: 0x81,
} as const;

export interface TunnelFrame {
  readonly tag: number;
  readonly conn: number;
  readonly payload: Uint8Array;
}

const HEADER_BYTES = 5;

export function encodeTunnelFrame(
  tag: number,
  conn: number,
  payload: Uint8Array | string = new Uint8Array(),
): Uint8Array {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  frame[0] = tag;
  new DataView(frame.buffer).setUint32(1, conn);
  frame.set(body, HEADER_BYTES);
  return frame;
}

export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame | undefined {
  if (bytes.length < HEADER_BYTES) return undefined;
  return {
    conn: new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(1),
    payload: bytes.subarray(HEADER_BYTES),
    tag: bytes[0] ?? 0,
  };
}
