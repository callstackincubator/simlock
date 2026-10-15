import type { OptionalModuleDefinition } from "../modules/index.js";

export interface AgentDeviceModuleConfig {
  readonly command: string;
  readonly leaseTtlCapMs?: number;
}

export const agentDeviceModule: OptionalModuleDefinition<AgentDeviceModuleConfig> = {
  config: {
    defaults: { command: "agent-device" },
    gatewayKeys: [],
    validator: (value) => value,
  },
  loadWorker: () => Promise.reject(new Error("agent-device's worker is not built yet")),
  name: "agent-device",
};
