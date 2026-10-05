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
const COMPARATOR = /^(>=|>|<=|<)(\d+(?:\.\d+)*)$/;
const HYPHEN = /^(\d+(?:\.\d+)*) - (\d+(?:\.\d+)*)$/;

export function parseOsConstraint(text: string): ParsedOsConstraint {
  if (VERSION.test(text)) return { constraint: { kind: "exact", version: text }, ok: true };
  const hyphen = HYPHEN.exec(text);
  if (hyphen !== null) {
    const bounds = [
      comparatorBound(">=", segments(hyphen[1] ?? "")),
      comparatorBound("<=", segments(hyphen[2] ?? "")),
    ];
    return { constraint: { bounds, kind: "range", text }, ok: true };
  }
  const bounds: Bound[] = [];
  for (const token of text.split(" ")) {
    const match = COMPARATOR.exec(token);
    if (match === null) return refused(text);
    bounds.push(comparatorBound(match[1] ?? "", segments(match[2] ?? "")));
  }
  return { constraint: { bounds, kind: "range", text }, ok: true };
}

function refused(text: string): ParsedOsConstraint {
  return { message: `Invalid OS constraint ${JSON.stringify(text)}: ${ACCEPTED_FORMS}`, ok: false };
}

function comparatorBound(operator: string, version: readonly number[]): Bound {
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

/** Whether a device OS satisfies a constraint; a bare version is string equality. */
export function satisfies(version: string, constraint: OsConstraint): boolean {
  if (constraint.kind === "exact") return constraint.version === version;
  if (!VERSION.test(version)) return false;
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
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
