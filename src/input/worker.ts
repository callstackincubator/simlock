import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { InputModuleConfig } from "./definition.js";
import { createWorkerInput } from "./create.js";

export function createWorker(ctx: WorkerContext<InputModuleConfig>): WorkerModule {
  const input = createWorkerInput({
    clock: ctx.clock,
    inputs: ctx.inputs,
    logger: ctx.logger,
    name: ctx.name,
    registry: ctx.registry,
  });
  return {
    capability: input.capability,
    hooks: {
      beforeDeviceReclaim: (ended) => input.leaseEnded(ended),
      beforeDrain: () => input.drain(),
    },
    leaseRoute: input.leaseRoute,
    relayTwoWay: input.relayTwoWay,
    socket: input.socket,
  };
}
