import type { GatewayContext, GatewayModule } from "../modules/index.js";
import type { InputModuleConfig } from "./definition.js";
import { createGatewayInput } from "./create.js";

export function createGateway(ctx: GatewayContext<InputModuleConfig>): GatewayModule {
  const input = createGatewayInput({
    clock: ctx.clock,
    leases: ctx.leases,
    relayTwoWay: (workerId, request, tenant, leaseId) =>
      ctx.relayTwoWay(workerId, request, tenant, leaseId),
    requesterPrefix: ctx.requesterPrefix,
  });
  return {
    hooks: { beforeDrain: () => Promise.resolve(input.drain()) },
    leaseRoute: input.leaseRoute,
    socket: input.socket,
  };
}
