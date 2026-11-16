/** why: a UDID is 36 characters, so its UTF-16 form is 72 bytes; a window overlaps the next by one byte less, and a match straddling two windows lies whole in one of them (ADR 0076 §4). */
export const SWAP_OVERLAP_BYTES = 71;

export interface LineageSwap {
  readonly lineage: readonly string[];
  readonly own: string;
}

/** why: ADR 0076 §4: a UDID is stored upper or lower case, as ASCII or as UTF-16 of either byte order, and no other way is looked for. */
function forms(udid: string): readonly Buffer[] {
  return [udid.toUpperCase(), udid.toLowerCase()].flatMap((text) => [
    Buffer.from(text, "latin1"),
    Buffer.from(text, "utf16le"),
    Buffer.from(text, "utf16le").swap16(),
  ]);
}

/** why: the finder of ADR 0076 §3: whether any lineage UDID is in the bytes in any of its forms. */
export function namesLineage(chunk: Uint8Array, lineage: readonly string[]): boolean {
  const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return lineage.some((udid) => forms(udid).some((form) => bytes.includes(form)));
}

/** why: the UDID swap (ADR 0076 §4) replaces each lineage UDID with the copy's own; a UDID has one length, so the output has the input's length, and a caller checks it. */
export function swapLineage(chunk: Uint8Array, swap: LineageSwap): Uint8Array {
  let out = Buffer.from(chunk);
  const own = Buffer.from(swap.own, "latin1");
  for (const udid of swap.lineage) {
    const needle = Buffer.from(udid, "latin1");
    if (needle.length === 0) continue;
    const pieces: Buffer[] = [];
    let from = 0;
    for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, from)) {
      pieces.push(out.subarray(from, at), own);
      from = at + needle.length;
    }
    pieces.push(out.subarray(from));
    out = Buffer.concat(pieces);
  }
  return out;
}
