export interface OsRange {
  readonly kind: "range";
}
export type OsConstraint = { readonly kind: "exact"; readonly version: string } | OsRange;
export type ParsedOsConstraint =
  | { readonly ok: true; readonly constraint: OsConstraint }
  | { readonly ok: false; readonly message: string };

export function parseOsConstraint(_text: string): ParsedOsConstraint {
  return { message: "not implemented", ok: false };
}
export function satisfies(_version: string, _constraint: OsConstraint): boolean {
  return false;
}
export function compareVersions(_left: string, _right: string): number {
  return 0;
}
