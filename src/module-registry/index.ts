import { agentDeviceModule } from "../agent-device/index.js";
import { inputModule } from "../input/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";
import { streamModule } from "../stream/index.js";
import { tunnelModule } from "../tunnel/index.js";

export const optionalModules: readonly OptionalModuleDefinition<unknown>[] = [
  agentDeviceModule as OptionalModuleDefinition<unknown>,
  inputModule as OptionalModuleDefinition<unknown>,
  streamModule as OptionalModuleDefinition<unknown>,
  tunnelModule as OptionalModuleDefinition<unknown>,
];
