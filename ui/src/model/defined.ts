// why: a view model leaves a missing fact out rather than holding `undefined`, which
// `exactOptionalPropertyTypes` refuses for an optional field; one helper drops them all at once.
export function defined<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
