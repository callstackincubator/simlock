import type { GatewayContext, GatewayModule } from "../modules/index.js";
import type { AgentDeviceModuleConfig } from "./definition.js";

// why: placeholder; the gateway side builds its fleet port and front here once green moves them out of main.ts.
export function createGateway(_ctx: GatewayContext<AgentDeviceModuleConfig>): GatewayModule {
  return {};
}
