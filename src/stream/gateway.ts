import type { GatewayContext, GatewayModule } from "../modules/index.js";
import { createGatewayStream } from "./create.js";
import type { StreamModuleConfig } from "./definition.js";

// fallow-ignore-next-line unused-export -- reached through the namespace of definition.ts's dynamic import.
export function createGateway(ctx: GatewayContext<StreamModuleConfig>): GatewayModule {
  const stream = createGatewayStream({
    fleet: {
      holder: (leaseId) => {
        const entry = ctx.leases.resolve(leaseId);
        return entry === undefined
          ? undefined
          : {
              ownerId: entry.ownerId,
              requesterId: entry.requesterId,
              workerId: entry.workerId,
              workerLeaseId: entry.workerLeaseId,
            };
      },
      relay: (workerId, call) => ctx.relay(workerId, call.request, call.tenant, call.leaseId),
      requesterPrefix: ctx.requesterPrefix,
    },
    logger: ctx.logger,
  });
  return { mount: () => (request, identity) => stream.mount.handle(request, identity) };
}
