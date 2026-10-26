import type { GatewayContext, GatewayModule } from "../modules/index.js";
import type { InputModuleConfig } from "./definition.js";
import { createGatewayInput } from "./create.js";

export function createGateway(ctx: GatewayContext<InputModuleConfig>): GatewayModule {
  const input = createGatewayInput({
    relayTwoWay: (workerId, request, tenant, leaseId) =>
      ctx.relayTwoWay(workerId, request, tenant, leaseId),
    requesterPrefix: ctx.requesterPrefix,
  });
  return { leaseRoute: input.leaseRoute, socket: input.socket };
}
