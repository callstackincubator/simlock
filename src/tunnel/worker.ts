import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { TunnelModuleConfig } from "./definition.js";

export function createWorker(ctx: WorkerContext<TunnelModuleConfig>): WorkerModule {
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
  };
}
