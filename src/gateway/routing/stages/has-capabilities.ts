import type { FilterStage } from "../pipeline.js";

export const hasCapabilities: FilterStage = {
  keeps() {
    return true;
  },
  appliesToPhysical: true,
  kind: "filter",
};
