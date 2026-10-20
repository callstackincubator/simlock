import { integerInRange, objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export interface StreamModuleConfig {
  readonly fps: number;
  readonly maxDimension: number;
  readonly bitrateKbps: number;
}

// why: the module is called `stream`, so its capability, its relay target and its route segment are
// one word; the picture settings are what a worker encodes with, and a gateway that only relays a
// stream reads none of them.
export const streamModule: OptionalModuleDefinition<StreamModuleConfig> = {
  config: {
    defaults: { bitrateKbps: 1_500, fps: 30, maxDimension: 720 },
    gatewayKeys: [],
    validator: objectValidator({
      bitrateKbps: integerInRange(100, 40_000),
      fps: integerInRange(1, 60),
      maxDimension: integerInRange(96, 4096),
    }),
  },
  loadGateway: () => import("./gateway.js"),
  loadWorker: () => import("./worker.js"),
  name: "stream",
};
