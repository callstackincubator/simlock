import type { GatewayContext, GatewayModule } from "../modules/index.js";
import type { TunnelModuleConfig } from "./definition.js";
import { createGatewayTunnelLink } from "./gateway-link.js";
import { upgradeRequired } from "./refusal.js";

export function createGateway(ctx: GatewayContext<TunnelModuleConfig>): GatewayModule {
  const link = createGatewayTunnelLink({
    relayTwoWay: (workerId, request, tenant, leaseId) =>
      ctx.relayTwoWay(workerId, request, tenant, leaseId),
    requesterPrefix: ctx.requesterPrefix,
  });
  return {
    leaseRoute: () => Promise.resolve(upgradeRequired()),
    socket: { open: link.open },
  };
}
