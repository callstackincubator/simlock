// why: a field that is absent stays absent on a stored record (never `undefined`), as `exactOptionalPropertyTypes` needs.
export function presentFields<T extends object>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
