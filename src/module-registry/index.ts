import { agentDeviceModule } from "../agent-device/definition.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export const optionalModules: readonly OptionalModuleDefinition<unknown>[] = [
  agentDeviceModule as OptionalModuleDefinition<unknown>,
];
