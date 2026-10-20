export const NAL_TYPE_SPS = 7;
export const NAL_TYPE_PPS = 8;

// why: every length prefix this module writes is four bytes, so the record that tells a decoder how
// to read them says so as a constant. Deriving it from anything in the parameter sets is the bug
// that made a decoder read three-byte lengths out of four-byte ones.
const AVCC_LENGTH_SIZE_MINUS_ONE_BYTE = 0xff;
const AVCC_LENGTH_BYTES = 4;
const MAX_SPS_COUNT = 31;
const MAX_PPS_COUNT = 255;

export class H264FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "H264FormatError";
  }
}

export function nalType(nal: Uint8Array): number {
  return (nal[0] ?? 0) & 0x1f;
}

export function splitAnnexB(bytes: Uint8Array): Uint8Array[] {
  const starts: { readonly at: number; readonly payload: number }[] = [];
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      starts.push({ at: index, payload: index + 3 });
      index += 2;
    }
  }
  const first = starts[0];
  if (first === undefined || !onlyZeros(bytes, 0, first.at)) {
    throw new H264FormatError("The encoder's packet does not start with an Annex-B start code");
  }
  const nals: Uint8Array[] = [];
  starts.forEach((start, position) => {
    let end = starts[position + 1]?.at ?? bytes.length;
    // why: a four-byte start code is a zero byte and a three-byte one, and Annex-B lets an encoder pad
    // a NAL unit with trailing zeros; neither belongs to the unit a decoder is handed.
    while (end > start.payload && bytes[end - 1] === 0) end -= 1;
    if (end > start.payload) nals.push(bytes.subarray(start.payload, end));
  });
  return nals;
}

export function toAvcc(nals: readonly Uint8Array[]): Uint8Array {
  const total = nals.reduce((sum, nal) => sum + AVCC_LENGTH_BYTES + nal.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const nal of nals) {
    view.setUint32(offset, nal.length);
    out.set(nal, offset + AVCC_LENGTH_BYTES);
    offset += AVCC_LENGTH_BYTES + nal.length;
  }
  return out;
}

export function avcDecoderConfiguration(
  sps: readonly Uint8Array[],
  pps: readonly Uint8Array[],
): Uint8Array {
  const first = sps[0];
  if (first === undefined || first.length < 4) {
    throw new H264FormatError("The encoder sent no sequence parameter set");
  }
  if (pps.length === 0) throw new H264FormatError("The encoder sent no picture parameter set");
  if (sps.length > MAX_SPS_COUNT || pps.length > MAX_PPS_COUNT) {
    throw new H264FormatError("The encoder sent more parameter sets than an avcC record holds");
  }
  const size =
    7 +
    sps.reduce((sum, nal) => sum + 2 + nal.length, 0) +
    pps.reduce((sum, nal) => sum + 2 + nal.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = first[1] ?? 0;
  out[2] = first[2] ?? 0;
  out[3] = first[3] ?? 0;
  out[4] = AVCC_LENGTH_SIZE_MINUS_ONE_BYTE;
  out[5] = 0xe0 | sps.length;
  let offset = 6;
  for (const nal of sps) offset = writeParameterSet(out, view, offset, nal);
  out[offset] = pps.length;
  offset += 1;
  for (const nal of pps) offset = writeParameterSet(out, view, offset, nal);
  return out;
}

function writeParameterSet(out: Uint8Array, view: DataView, offset: number, nal: Uint8Array) {
  if (nal.length > 0xffff) throw new H264FormatError("A parameter set is longer than avcC allows");
  view.setUint16(offset, nal.length);
  out.set(nal, offset + 2);
  return offset + 2 + nal.length;
}

function onlyZeros(bytes: Uint8Array, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (bytes[index] !== 0) return false;
  return true;
}
