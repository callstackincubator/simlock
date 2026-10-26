import { objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export type InputModuleConfig = Record<string, never>;

export const inputModule: OptionalModuleDefinition<InputModuleConfig> = {
  config: {
    defaults: {},
    gatewayKeys: [],
    validator: objectValidator({}),
  },
  loadGateway: () => import("./gateway.js"),
  loadWorker: () => import("./worker.js"),
  name: "input",
};
