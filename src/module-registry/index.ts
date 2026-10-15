import { agentDeviceModule } from "../agent-device/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export const optionalModules: readonly OptionalModuleDefinition<unknown>[] = [
  agentDeviceModule as OptionalModuleDefinition<unknown>,
];
