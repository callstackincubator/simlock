import type { FilterStage } from "../pipeline.js";

export const hasCapabilities: FilterStage = {
  keeps(worker, request) {
    return listsAllAvailable(worker.capabilities, request.requires);
  },
  appliesToPhysical: true,
  kind: "filter",
};

function listsAllAvailable(
  capabilities: readonly { readonly name: string; readonly state: string }[] | undefined,
  requires: readonly string[] | undefined,
): boolean {
  if (requires === undefined) return true;
  return requires.every((name) =>
    capabilities?.some((entry) => entry.name === name && entry.state === "available"),
  );
}
