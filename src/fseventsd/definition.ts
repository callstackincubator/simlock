import { objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

// why: the module has no keys; a worker reads fseventsd's memory when doctor asks, with nothing to set.
export type FseventsdModuleConfig = Record<string, never>;

export const fseventsdModule: OptionalModuleDefinition<FseventsdModuleConfig> = {
  config: {
    defaults: {},
    gatewayKeys: [],
    validator: objectValidator({}),
  },
  loadWorker: () => import("./worker.js"),
  name: "fseventsd",
};
