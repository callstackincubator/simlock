import { objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export type TunnelModuleConfig = Record<string, never>;

export const tunnelModule: OptionalModuleDefinition<TunnelModuleConfig> = {
  config: {
    defaults: {},
    gatewayKeys: [],
    validator: objectValidator({}),
  },
  loadWorker: () => import("./worker.js"),
  name: "tunnel",
};
