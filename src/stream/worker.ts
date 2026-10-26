import type { WorkerContext, WorkerModule } from "../modules/index.js";
import { createWorkerStream } from "./create.js";
import type { StreamModuleConfig } from "./definition.js";

export function createWorker(ctx: WorkerContext<StreamModuleConfig>): WorkerModule {
  const stream = createWorkerStream({
    clock: ctx.clock,
    events: ctx.events,
    instanceId: ctx.instanceId,
    logger: ctx.logger,
    name: ctx.name,
    registry: ctx.registry,
    screens: ctx.screens,
    settings: ctx.config,
  });
  return {
    capability: stream.capabilitySource,
    hooks: { beforeDeviceReclaim: (ended, signal) => stream.leaseEnd.leaseEnded(ended, signal) },
    leaseRoute: stream.leaseRoute,
    mount: () => (request, identity) => stream.mount.handle(request, identity),
    relayTarget: stream.relayTarget,
  };
}
