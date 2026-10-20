import { agentDeviceModule } from "../agent-device/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";
import { streamModule } from "../stream/index.js";

export const optionalModules: readonly OptionalModuleDefinition<unknown>[] = [
  agentDeviceModule as OptionalModuleDefinition<unknown>,
  streamModule as OptionalModuleDefinition<unknown>,
];
