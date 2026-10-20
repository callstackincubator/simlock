import { SCRCPY_CODEC_H264 } from "./scrcpy-video.js";
import { SAMPLE_H264 } from "./test-fixture.js";

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function codecId(id = SCRCPY_CODEC_H264): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, id);
  return out;
}

export function sessionPacket(width: number, height: number, clientResized = false): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x80000000 | (clientResized ? 1 : 0));
  view.setUint32(4, width);
  view.setUint32(8, height);
  return out;
}

export function mediaPacket(
  flags: { readonly config?: boolean; readonly key?: boolean; readonly pts?: number },
  payload: Uint8Array,
  claimedSize = payload.length,
): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  const pts = flags.pts ?? 0;
  let high = Math.floor(pts / 2 ** 32);
  if (flags.config === true) high = 0x40000000;
  else if (flags.key === true) high |= 0x20000000;
  view.setUint32(0, high);
  view.setUint32(4, flags.config === true ? 0 : pts % 2 ** 32);
  view.setUint32(8, claimedSize);
  out.set(payload, 12);
  return out;
}

// why: the fixture cut where an encoder hands its output over -- parameter sets, then one access unit
// per packet -- with the offsets read from the file's own start codes.
export const SAMPLE = {
  config: SAMPLE_H264.subarray(0, 36),
  idr: SAMPLE_H264.subarray(36, 1070),
  p1: SAMPLE_H264.subarray(1070, 1120),
  p2: SAMPLE_H264.subarray(1120, 1184),
  idrWithParameterSets: SAMPLE_H264.subarray(1184, 2285),
  p3: SAMPLE_H264.subarray(2285),
};

export function sampleStream(): Uint8Array {
  return concatBytes(
    codecId(),
    sessionPacket(96, 64),
    mediaPacket({ config: true }, SAMPLE.config),
    mediaPacket({ key: true, pts: 0 }, SAMPLE.idr),
    mediaPacket({ pts: 100_000 }, SAMPLE.p1),
    mediaPacket({ pts: 200_000 }, SAMPLE.p2),
    mediaPacket({ key: true, pts: 300_000 }, SAMPLE.idrWithParameterSets),
    mediaPacket({ pts: 400_000 }, SAMPLE.p3),
  );
}
