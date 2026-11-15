import type { SimctlCatalog } from "./simctl-parse.js";
import type { ReadySeed, SourceRow } from "./source-data.js";

/** why: a seed in another set than today's sources folder, or without an index of its files, was made before ADR 0076, and a copy of it cannot be fixed from; a seed built on a runtime whose build changed no longer matches it; with no build on either side only the runtime's presence is checked, and a provision always has the runtime. */
export function seedIsStale(
  seed: ReadySeed,
  currentBuild: string | undefined,
  sourcesSet: string,
): boolean {
  if (seed.setPath !== sourcesSet || !seed.indexed) return true;
  return (
    seed.runtimeBuild !== undefined &&
    currentBuild !== undefined &&
    seed.runtimeBuild !== currentBuild
  );
}

/** why: the phrase reads after "is stale:" in `doctor`, and is what a person acts on, so it names the runtime or device type by id. */
export function sourceStaleReason(
  row: SourceRow,
  catalog: SimctlCatalog,
  sourcesSet: string,
): string | undefined {
  if (row.setPath !== sourcesSet || !row.indexed) {
    return `saved in ${row.setPath}, which copies cannot be fixed from; save it again`;
  }
  const runtime = catalog.runtimes.find((entry) => entry.identifier === row.runtimeId);
  if (runtime === undefined) return `runtime ${row.runtimeId} is not installed`;
  if (
    row.runtimeBuild !== undefined &&
    runtime.build !== undefined &&
    row.runtimeBuild !== runtime.build
  ) {
    return `runtime ${row.runtimeId} changed from build ${row.runtimeBuild} to ${runtime.build}`;
  }
  if (!catalog.deviceTypes.some((entry) => entry.identifier === row.deviceTypeId)) {
    return `device type ${row.deviceTypeId} is not available`;
  }
  return undefined;
}
