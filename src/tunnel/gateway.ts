import { type GatewayContext, type GatewayModule, upgradeRequired } from "../modules/index.js";
import type { TunnelModuleConfig } from "./definition.js";
import { createGatewayTunnelLink } from "./gateway-link.js";

export function createGateway(ctx: GatewayContext<TunnelModuleConfig>): GatewayModule {
  const link = createGatewayTunnelLink({
    clock: ctx.clock,
    leases: ctx.leases,
    relayTwoWay: (workerId, request, tenant, leaseId) =>
      ctx.relayTwoWay(workerId, request, tenant, leaseId),
    requesterPrefix: ctx.requesterPrefix,
  });
  return {
    hooks: { beforeDrain: () => Promise.resolve(link.drain()) },
    leaseRoute: () => Promise.resolve(upgradeRequired()),
    socket: { open: link.open },
  };
}
