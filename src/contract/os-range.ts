/**
 * The one grammar for an OS constraint (ADR 0015 §2; architecture rule 10): a bare version, which
 * is exact, or a range in a node-semver subset. Parses a string, tests a version against the
 * result, and orders versions. It lives in the contract so the `osVersion` schema can refine
 * through it and the core and the gateway can import it; no dependency is added.
 *
 * A partial version covers its prefix as node-semver reads it: `>=18` is 18.0 onward, `<=26`
 * includes every 26.x, `>26` excludes every 26.x, `<18` excludes every 18.x, and `18 - 26` is
 * `>=18 <=26`.
 */

/** A version at or above `from`, and below `before` when it has one. */
interface Bound {
  readonly from?: readonly number[];
  readonly before?: readonly number[];
}

export interface OsRange {
  readonly kind: "range";
  /** The text as typed, so an event or an error can show it back. */
  readonly text: string;
  readonly bounds: readonly Bound[];
}

export type OsConstraint = { readonly kind: "exact"; readonly version: string } | OsRange;

export type ParsedOsConstraint =
  | { readonly ok: true; readonly constraint: OsConstraint }
  | { readonly ok: false; readonly message: string };

/** The message a refused constraint carries, naming every accepted form. */
const ACCEPTED_FORMS =
  "an OS constraint is an exact version (`18.4`), or a range: one or more of `>=`, `>`, `<=`, `<` " +
  "followed by a version, joined by single spaces (`>=18 <26`), or a hyphen range (`18 - 26`)";

const VERSION = /^\d+(?:\.\d+)*$/;
const OPERATORS = [">=", ">", "<=", "<"] as const;

/**
 * Whether a string is written as a range rather than a version: it starts with a comparator, or
 * has a hyphen range, a caret, a tilde, a star, `||`, or an `x` segment. Anything else is a bare
 * version, which stays exact as on `main`, so a runtime a driver lists as `Baklava` or `34-ext12`
 * still names itself.
 */
function looksLikeRange(text: string): boolean {
  return (
    /^[<>=]/.test(text) ||
    / - |\^|~|\*|\|\|/.test(text) ||
    text.split(".").some((segment) => segment === "x" || segment === "X")
  );
}

export function parseOsConstraint(text: string): ParsedOsConstraint {
  if (text === "") return refused(text);
  if (!looksLikeRange(text)) return { constraint: { kind: "exact", version: text }, ok: true };
  const bounds = hyphenBounds(text) ?? comparatorBounds(text);
  return bounds === undefined
    ? refused(text)
    : { constraint: { bounds, kind: "range", text }, ok: true };
}

/** `A - B` is `>=A <=B`. */
function hyphenBounds(text: string): readonly Bound[] | undefined {
  const parts = text.split(" - ");
  if (parts.length !== 2 || !parts.every((part) => VERSION.test(part))) return undefined;
  const [from, to] = parts.map(segments) as [readonly number[], readonly number[]];
  return [comparatorBound(">=", from), comparatorBound("<=", to)];
}

/** One or more comparators joined by single spaces. */
function comparatorBounds(text: string): readonly Bound[] | undefined {
  const bounds: Bound[] = [];
  for (const token of text.split(" ")) {
    const operator = OPERATORS.find((candidate) => token.startsWith(candidate));
    if (operator === undefined) return undefined;
    const version = token.slice(operator.length);
    if (!VERSION.test(version)) return undefined;
    bounds.push(comparatorBound(operator, segments(version)));
  }
  return bounds;
}

function refused(text: string): ParsedOsConstraint {
  return { message: `Invalid OS constraint ${JSON.stringify(text)}: ${ACCEPTED_FORMS}`, ok: false };
}

function comparatorBound(operator: (typeof OPERATORS)[number], version: readonly number[]): Bound {
  switch (operator) {
    case ">=":
      return { from: version };
    case ">":
      return { from: bump(version) };
    case "<=":
      return { before: bump(version) };
    default:
      return { before: version };
  }
}

/** The next version of the same precision: 18 -> 19, 18.4 -> 18.5. */
function bump(version: readonly number[]): readonly number[] {
  return version.map((part, index) => (index === version.length - 1 ? part + 1 : part));
}

function segments(version: string): readonly number[] {
  return version.split(".").map(Number);
}

/**
 * Whether a device OS satisfies a constraint; a bare version is string equality. A version that is
 * not dotted integers (`Baklava`) reads as NaN, which every bound refuses, so it satisfies no range.
 */
export function satisfies(version: string, constraint: OsConstraint): boolean {
  if (constraint.kind === "exact") return constraint.version === version;
  const parts = segments(version);
  return constraint.bounds.every(
    (bound) =>
      (bound.from === undefined || compareSegments(parts, bound.from) >= 0) &&
      (bound.before === undefined || compareSegments(parts, bound.before) < 0),
  );
}

/** Orders dotted integers, a missing segment reading as 0: negative when `left` is older. */
export function compareVersions(left: string, right: string): number {
  return compareSegments(segments(left), segments(right));
}

function compareSegments(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  const differences = Array.from(
    { length },
    (_, index) => (left[index] ?? 0) - (right[index] ?? 0),
  );
  return differences.find((difference) => difference !== 0) ?? 0;
}
