import { describe, expect, it } from "vitest";

import { avcDecoderConfiguration, H264FormatError, splitAnnexB, toAvcc } from "./h264.js";
import { SAMPLE_H264 } from "./test-fixture.js";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("splitAnnexB", () => {
  it("splits on three- and four-byte start codes alike, keeping neither in a unit", () => {
    const stream = bytes(0, 0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 0, 1, 0x65, 0xcc);
    expect(splitAnnexB(stream).map((nal) => [...nal])).toEqual([
      [0x67, 0xaa],
      [0x68, 0xbb],
      [0x65, 0xcc],
    ]);
  });

  it("drops the trailing zero bytes an encoder pads a unit with", () => {
    expect(splitAnnexB(bytes(0, 0, 1, 0x65, 0x11, 0, 0)).map((nal) => [...nal])).toEqual([
      [0x65, 0x11],
    ]);
  });

  it("keeps emulation-prevention bytes, which are part of the unit", () => {
    expect([...splitAnnexB(bytes(0, 0, 1, 0x67, 0, 0, 3, 1, 0x80))[0]!]).toEqual([
      0x67, 0, 0, 3, 1, 0x80,
    ]);
  });

  it("refuses a packet that does not start with a start code", () => {
    expect(splitAnnexB(bytes(0, 0, 1, 0x65)).length).toBe(1);
    expect(() => splitAnnexB(bytes(0x65, 0, 0, 1, 0x65))).toThrow(H264FormatError);
  });

  it("splits the fixture into the nine units its encoder wrote, in order", () => {
    expect(splitAnnexB(SAMPLE_H264).map((nal) => nal[0]! & 0x1f)).toEqual([
      7, 8, 5, 1, 1, 7, 8, 5, 1,
    ]);
  });
});

describe("toAvcc", () => {
  it("prefixes every unit with its length as four big-endian bytes", () => {
    expect([...toAvcc([bytes(0x65, 1, 2), bytes(0x41)])]).toEqual([
      0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 1, 0x41,
    ]);
  });
});

describe("avcDecoderConfiguration", () => {
  const [sps, pps] = splitAnnexB(SAMPLE_H264);

  it("takes profile, compatibility and level from the SPS and declares four-byte lengths", () => {
    const record = avcDecoderConfiguration([sps!], [pps!]);
    expect([...record.subarray(0, 6)]).toEqual([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1]);
    expect(new DataView(record.buffer).getUint16(6)).toBe(sps!.length);
    expect([...record.subarray(8, 8 + sps!.length)]).toEqual([...sps!]);
    const ppsAt = 8 + sps!.length;
    expect(record[ppsAt]).toBe(1);
    expect(new DataView(record.buffer).getUint16(ppsAt + 1)).toBe(pps!.length);
    expect([...record.subarray(ppsAt + 3)]).toEqual([...pps!]);
  });

  it("declares four-byte lengths whatever the SPS's own bytes say", () => {
    const odd = bytes(0x67, 0x64, 0x00, 0x28, 0x00);
    expect(avcDecoderConfiguration([odd], [bytes(0x68, 1)])[4]).toBe(0xff);
  });

  it("counts every SPS and PPS it carries", () => {
    const record = avcDecoderConfiguration([sps!, sps!], [pps!, pps!, pps!]);
    expect(record[5]).toBe(0xe2);
    expect(record[6 + 2 * (2 + sps!.length)]).toBe(3);
  });

  it("refuses a record without a picture parameter set", () => {
    expect(() => avcDecoderConfiguration([sps!], [])).toThrow(/picture parameter set/);
  });
});
