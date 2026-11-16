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

/** why: the UDID swap (ADR 0076 §4) replaces each lineage UDID with the copy's own, byte for byte, so the output has the input's length. */
export function swapLineage(chunk: Uint8Array, swap: LineageSwap): Uint8Array {
  const out = Buffer.from(chunk);
  const own = Buffer.from(swap.own, "latin1");
  for (const udid of swap.lineage) {
    const needle = Buffer.from(udid, "latin1");
    for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + needle.length)) {
      own.copy(out, at);
    }
  }
  return out;
}
