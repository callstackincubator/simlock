import { describe, expect, it } from "vitest";

import { SCREEN_FRAME_HEADER_BYTES, SCREEN_FRAME_TAG } from "../../../core/index.js";
import { EnvelopeMapper } from "./envelope.js";
import { avcDecoderConfiguration, splitAnnexB, toAvcc } from "./h264.js";
import { ScrcpyVideoParser } from "./scrcpy-video.js";
import {
  codecId,
  concatBytes,
  mediaPacket,
  SAMPLE,
  sampleStream,
  sessionPacket,
} from "./test-scrcpy.js";

interface Frame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

function frames(stream: Uint8Array, fps = 30): Frame[] {
  const parser = new ScrcpyVideoParser();
  const mapper = new EnvelopeMapper(fps);
  return parser
    .push(stream)
    .flatMap((event) => mapper.map(event))
    .map((frame) => {
      expect(new DataView(frame.buffer).getUint32(0)).toBe(
        frame.length - SCREEN_FRAME_HEADER_BYTES + 1,
      );
      return { payload: frame.subarray(SCREEN_FRAME_HEADER_BYTES), tag: frame[4]! };
    });
}

const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe("EnvelopeMapper", () => {
  it("writes meta, then the description, then the key frame and its deltas", () => {
    expect(frames(sampleStream()).map((frame) => frame.tag)).toEqual([
      SCREEN_FRAME_TAG.meta,
      SCREEN_FRAME_TAG.description,
      SCREEN_FRAME_TAG.keyframe,
      SCREEN_FRAME_TAG.delta,
      SCREEN_FRAME_TAG.delta,
      SCREEN_FRAME_TAG.keyframe,
      SCREEN_FRAME_TAG.delta,
    ]);
  });

  it("names the session's size and the asked-for frame rate in the meta frame", () => {
    expect(json(frames(sampleStream(), 24)[0]!.payload)).toEqual({
      codec: "h264",
      fps: 24,
      height: 64,
      width: 96,
    });
  });

  it("describes the stream with the avcC record of the config packet's parameter sets", () => {
    const [sps, pps] = splitAnnexB(SAMPLE.config);
    expect([...frames(sampleStream())[1]!.payload]).toEqual([
      ...avcDecoderConfiguration([sps!], [pps!]),
    ]);
  });

  it("carries every unit of a picture as AVCC, in-band parameter sets included", () => {
    const written = frames(sampleStream());
    expect([...written[2]!.payload]).toEqual([...toAvcc(splitAnnexB(SAMPLE.idr))]);
    expect([...written[3]!.payload]).toEqual([...toAvcc(splitAnnexB(SAMPLE.p1))]);
    expect([...written[5]!.payload]).toEqual([...toAvcc(splitAnnexB(SAMPLE.idrWithParameterSets))]);
    expect(written[5]!.payload.indexOf(0x67)).toBeGreaterThan(0);
  });

  it("starts a rotated session with a fresh meta and description before its first picture", () => {
    const rotated = concatBytes(
      sampleStream(),
      sessionPacket(64, 96),
      mediaPacket({ config: true }, SAMPLE.config),
      mediaPacket({ key: true }, SAMPLE.idr),
    );
    const tail = frames(rotated).slice(-3);
    expect(tail.map((frame) => frame.tag)).toEqual([
      SCREEN_FRAME_TAG.meta,
      SCREEN_FRAME_TAG.description,
      SCREEN_FRAME_TAG.keyframe,
    ]);
    expect(json(tail[0]!.payload)).toMatchObject({ height: 96, width: 64 });
  });

  it("joins parameter sets an encoder hands over in two config packets", () => {
    const [sps, pps] = splitAnnexB(SAMPLE.config);
    const split = concatBytes(
      codecId(),
      sessionPacket(96, 64),
      mediaPacket({ config: true }, SAMPLE.config.subarray(0, 27)),
      mediaPacket({ config: true }, SAMPLE.config.subarray(27)),
      mediaPacket({ key: true }, SAMPLE.idr),
    );
    expect([...frames(split)[1]!.payload]).toEqual([...avcDecoderConfiguration([sps!], [pps!])]);
  });

  it("refuses a picture before the session named its size or before any parameter sets", () => {
    const sized = concatBytes(
      codecId(),
      sessionPacket(96, 64),
      mediaPacket({ config: true }, SAMPLE.config),
    );
    expect(frames(concatBytes(sized, mediaPacket({ key: true }, SAMPLE.idr)))).toHaveLength(3);
    expect(() => frames(concatBytes(codecId(), mediaPacket({ key: true }, SAMPLE.idr)))).toThrow(
      /size/,
    );
    expect(() =>
      frames(concatBytes(codecId(), sessionPacket(96, 64), mediaPacket({ key: true }, SAMPLE.idr))),
    ).toThrow(/parameter sets/);
  });
});
