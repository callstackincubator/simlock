import { integerInRange, invalidValue, nonEmptyString, objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export interface AgentDeviceModuleConfig {
  readonly command: string;
  readonly leaseTtlCapMs?: number;
}

/** why: agent-device's shortest lease window, so a cap below it would shorten leases past what agent-device keeps. */
const MIN_AGENT_DEVICE_LEASE_TTL_MS = 5_000;

export const agentDeviceModule: OptionalModuleDefinition<AgentDeviceModuleConfig> = {
  config: {
    check(section, config) {
      const cap = section.leaseTtlCapMs;
      if (cap !== undefined && cap > config.lease.maxTtlMs) {
        throw invalidValue("capabilities.agent-device.leaseTtlCapMs", "at most lease.maxTtlMs");
      }
    },
    defaults: { command: "agent-device" },
    gatewayKeys: ["leaseTtlCapMs"],
    validator: objectValidator({
      command: nonEmptyString,
      leaseTtlCapMs: integerInRange(MIN_AGENT_DEVICE_LEASE_TTL_MS, Number.MAX_SAFE_INTEGER),
    }),
  },
  loadGateway: () => import("./gateway.js"),
  loadWorker: () => import("./worker.js"),
  name: "agent-device",
};
