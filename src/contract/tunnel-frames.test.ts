import { describe, expect, it } from "vitest";

import { decodeTunnelFrame, encodeTunnelFrame, TUNNEL_TAG } from "./index.js";

describe("the tunnel frame codec", () => {
  it("encodes [tag][conn u32 big-endian][payload], decodes it from a view that does not start at byte 0, and answers undefined for fewer than 5 bytes", () => {
    expect([...encodeTunnelFrame(TUNNEL_TAG.data, 0x01020304, "hi")]).toEqual([
      3, 1, 2, 3, 4, 104, 105,
    ]);
    expect([...encodeTunnelFrame(TUNNEL_TAG.data, 1, Uint8Array.of(9, 8))]).toEqual([
      3, 0, 0, 0, 1, 9, 8,
    ]);
    expect([...encodeTunnelFrame(TUNNEL_TAG.end, 7)]).toEqual([5, 0, 0, 0, 7]);

    const pooled = Uint8Array.of(0xff, 0xff, 3, 0xff, 0xff, 0xff, 0xfe, 104, 105).subarray(2);
    const decoded = decodeTunnelFrame(pooled);
    expect(decoded?.tag).toBe(3);
    expect(decoded?.conn).toBe(0xff_ff_ff_fe);
    expect([...(decoded?.payload ?? [])]).toEqual([104, 105]);

    expect(decodeTunnelFrame(Uint8Array.of(5, 0, 0, 0, 7))).toEqual({
      conn: 7,
      payload: new Uint8Array(),
      tag: 5,
    });
    expect(decodeTunnelFrame(Uint8Array.of(1, 0, 0, 0))).toBeUndefined();
  });
});
