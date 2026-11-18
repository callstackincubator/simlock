import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { FseventsdModuleConfig } from "./definition.js";

export function createWorker(ctx: WorkerContext<FseventsdModuleConfig>): WorkerModule {
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
    findings: () => [],
  };
}
