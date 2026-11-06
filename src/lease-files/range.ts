export type RangeAnswer =
  | { readonly kind: "whole" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const WHOLE: RangeAnswer = { kind: "whole" };
const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * why: one `bytes=a-b`, `a-` or `-n` range is served; several ranges, another unit, a malformed
 * value and `b < a` are ignored, which answers the whole file.
 */
export function parseRange(header: string | null, size: number): RangeAnswer {
  const match = header === null ? null : SINGLE_BYTE_RANGE.exec(header.trim());
  if (match === null) return WHOLE;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return WHOLE;
  if (first === "") {
    const count = Number(last);
    if (count === 0 || size === 0) return { kind: "unsatisfiable" };
    return { end: size - 1, kind: "range", start: Math.max(0, size - count) };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return WHOLE;
  if (start >= size) return { kind: "unsatisfiable" };
  return {
    end: last === "" ? size - 1 : Math.min(Number(last), size - 1),
    kind: "range",
    start,
  };
}
