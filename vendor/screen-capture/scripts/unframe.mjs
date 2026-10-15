// why: ffprobe reads Annex-B, not the length-prefixed envelope the capture tool writes, so proving
// a captured stream actually decodes needs something in between. Prints the per-tag frame counts
// while it is at it, because a stream that decodes but is missing its keyframe proves nothing.
//
//   node scripts/unframe.mjs capture.bin out.264
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/unframe.mjs <capture.bin> <out.264>");
  process.exit(64);
}

const TAGS = { 1: "description", 2: "keyframe", 3: "delta", 4: "seed", 5: "meta" };
const START = Buffer.from([0, 0, 0, 1]);

const buf = readFileSync(input);
let offset = 0;
let malformed = 0;
const counts = {};
const parameterSets = [];
const slices = [];
let meta = null;

while (offset + 5 <= buf.length) {
  const length = buf.readUInt32BE(offset);
  const tag = buf[offset + 4];
  const payload = buf.subarray(offset + 5, offset + 5 + length - 1);
  if (payload.length !== length - 1) {
    malformed++;
    break;
  }
  counts[TAGS[tag] ?? `unknown(${tag})`] = (counts[TAGS[tag] ?? `unknown(${tag})`] ?? 0) + 1;
  if (tag === 5) meta = JSON.parse(payload.toString("utf8"));
  if (tag === 1) parameterSets.push(...extractParameterSets(payload));
  if (tag === 2 || tag === 3) slices.push(...extractNalUnits(payload));
  offset += 5 + length - 1;
}

// why: a decoder needs SPS+PPS in-band before the first IDR, so the avcC blob's parameter sets are
// written ahead of the frames rather than left in the description frame a decoder may see too late.
writeFileSync(
  output,
  Buffer.concat([
    START,
    parameterSets[0],
    START,
    parameterSets[1],
    ...slices.flatMap((nal) => [START, nal]),
  ]),
);

// why: the payload is repeated 4-byte length + NAL unit, and the lengths are read rather than
// scanned for start codes -- a NAL's own bytes can look like a start code.
function extractNalUnits(payload) {
  const units = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const size = payload.readUInt32BE(i);
    units.push(Buffer.from(payload.subarray(i + 4, i + 4 + size)));
    i += 4 + size;
  }
  return units;
}

// why: the avcC layout is fixed by ISO/IEC 14496-15 §5.2.4.1 -- ver, profile, compat, level,
// lengthSize, SPS count, SPS[], PPS count, PPS[] -- so the offsets below are the spec's, not ours.
function extractParameterSets(avcc) {
  const sets = [];
  let i = 5;
  const spsCount = avcc[i] & 0x1f;
  i += 1;
  for (let s = 0; s < spsCount; s++) {
    const size = avcc.readUInt16BE(i);
    i += 2;
    sets.push(Buffer.from(avcc.subarray(i, i + size)));
    i += size;
  }
  const ppsCount = avcc[i];
  i += 1;
  for (let s = 0; s < ppsCount; s++) {
    const size = avcc.readUInt16BE(i);
    i += 2;
    sets.push(Buffer.from(avcc.subarray(i, i + size)));
    i += size;
  }
  return sets;
}

console.log(
  JSON.stringify({
    meta,
    counts,
    malformed,
    bytes: buf.length,
    parameterSets: parameterSets.length,
    slices: slices.length,
  }),
);
