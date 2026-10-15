import { describe, expect, it } from "vitest";

import {
  MAX_SCRCPY_PACKET_BYTES,
  ScrcpyProtocolError,
  type ScrcpyVideoEvent,
  ScrcpyVideoParser,
} from "./scrcpy-video.js";
import {
  codecId,
  concatBytes,
  mediaPacket,
  SAMPLE,
  sampleStream,
  sessionPacket,
} from "./test-scrcpy.js";

function parseInChunks(stream: Uint8Array, cuts: readonly number[]): ScrcpyVideoEvent[] {
  const parser = new ScrcpyVideoParser();
  const events: ScrcpyVideoEvent[] = [];
  let from = 0;
  for (const cut of [...cuts, stream.length]) {
    events.push(...parser.push(stream.subarray(from, cut)));
    from = cut;
  }
  return events;
}

function summary(events: readonly ScrcpyVideoEvent[]) {
  return events.map((event) =>
    event.kind === "session"
      ? { height: event.height, kind: event.kind, width: event.width }
      : {
          config: event.config,
          key: event.key,
          kind: event.kind,
          payload: [...event.payload],
          pts: event.pts,
        },
  );
}

describe("ScrcpyVideoParser", () => {
  const stream = sampleStream();
  const whole = summary(parseInChunks(stream, []));

  it("reads the session packet, then config, key and delta packets with their PTS", () => {
    expect(
      whole.map((event) => ("config" in event ? [event.config, event.key, event.pts] : event)),
    ).toEqual([
      { height: 64, kind: "session", width: 96 },
      [true, false, 0],
      [false, true, 0],
      [false, false, 100_000],
      [false, false, 200_000],
      [false, true, 300_000],
      [false, false, 400_000],
    ]);
    expect(whole[3]).toMatchObject({ payload: [...SAMPLE.p1] });
  });

  it("reads the same events however the bytes are split in two, at every offset", () => {
    // why: small payloads keep every packet kind and every header boundary while making each of the
    // cuts cheap to compare, so the test proves the framing and not the machine's speed.
    const small = concatBytes(
      codecId(),
      sessionPacket(96, 64),
      mediaPacket({ config: true }, new Uint8Array([0, 0, 0, 1, 0x67, 1])),
      mediaPacket({ key: true, pts: 0 }, new Uint8Array([0, 0, 0, 1, 0x65, 2])),
      mediaPacket({ pts: 100_000 }, new Uint8Array([0, 0, 0, 1, 0x41, 3])),
      sessionPacket(64, 96),
    );
    const expected = summary(parseInChunks(small, []));
    expect(expected).toHaveLength(5);
    for (let cut = 1; cut < small.length; cut += 1) {
      expect(summary(parseInChunks(small, [cut])), `cut at ${String(cut)}`).toEqual(expected);
    }
  });

  it("reads the same events from one byte at a time", () => {
    const cuts = Array.from({ length: stream.length - 1 }, (_, index) => index + 1);
    expect(summary(parseInChunks(stream, cuts))).toEqual(whole);
  });

  it("reads a large PTS whose high bits sit beside the flags", () => {
    const pts = 2 ** 40 + 7;
    const events = parseInChunks(
      concatBytes(codecId(), mediaPacket({ key: true, pts }, new Uint8Array([0, 0, 1, 0x65]))),
      [],
    );
    expect(events[0]).toMatchObject({ config: false, key: true, pts });
  });

  it("holds a packet back until its last byte arrives", () => {
    const parser = new ScrcpyVideoParser();
    const packet = mediaPacket({ key: true }, SAMPLE.idr);
    expect(parser.push(concatBytes(codecId(), packet.subarray(0, packet.length - 1)))).toEqual([]);
    expect(parser.push(packet.subarray(packet.length - 1))).toHaveLength(1);
  });

  it("refuses a stream the server disabled, failed to configure, or encodes in another codec", () => {
    expect(parseInChunks(codecId(), [])).toEqual([]);
    expect(() => parseInChunks(codecId(0), [])).toThrow(/disabled/);
    expect(() => parseInChunks(codecId(1), [])).toThrow(/could not configure/);
    expect(() => parseInChunks(codecId(0x68323635), [])).toThrow(ScrcpyProtocolError);
  });

  it("refuses a packet claiming more than a viewer reads, before buffering it", () => {
    const header = (size: number) => mediaPacket({ key: true }, new Uint8Array(0), size);
    expect(parseInChunks(concatBytes(codecId(), header(MAX_SCRCPY_PACKET_BYTES)), [])).toEqual([]);
    expect(() =>
      parseInChunks(concatBytes(codecId(), header(MAX_SCRCPY_PACKET_BYTES + 1)), []),
    ).toThrow(ScrcpyProtocolError);
  });

  it("refuses a session with no picture", () => {
    expect(parseInChunks(concatBytes(codecId(), sessionPacket(1, 1)), [])).toHaveLength(1);
    expect(() => parseInChunks(concatBytes(codecId(), sessionPacket(0, 64)), [])).toThrow(
      ScrcpyProtocolError,
    );
  });
});
