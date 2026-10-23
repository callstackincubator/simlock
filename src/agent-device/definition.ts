import { integerInRange, invalidValue, nonEmptyString, objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export interface AgentDeviceModuleConfig {
  readonly command: string;
  readonly leaseTtlCapMs?: number;
  readonly ios?: {
    readonly teamId?: string;
    readonly bundleId?: string;
    readonly provisioningProfile?: string;
    readonly signingIdentity?: string;
  };
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
      ios: objectValidator({
        bundleId: nonEmptyString,
        provisioningProfile: nonEmptyString,
        signingIdentity: nonEmptyString,
        teamId: nonEmptyString,
      }),
      leaseTtlCapMs: integerInRange(MIN_AGENT_DEVICE_LEASE_TTL_MS, Number.MAX_SAFE_INTEGER),
    }),
  },
  enabledByDefault: "standalone-worker",
  localProfile: {
    fileName: "agent-device-profile.json",
    render: (origin, secret) =>
      `${JSON.stringify(
        {
          // why: agent-device refuses a proxy open without a clientId; it is a constant so the file's bytes stay stable.
          clientId: "a51a51a51a51a51a",
          daemonAuthToken: secret,
          daemonBaseUrl: `${origin}/v1/agent-device`,
          daemonTransport: "http",
          leaseProvider: "proxy",
          runId: "simlock-local",
          sessionIsolation: "tenant",
          tenant: "local",
        },
        null,
        2,
      )}\n`,
    tokenLabel: "agent-device on this Mac",
  },
  loadGateway: () => import("./gateway.js"),
  loadWorker: () => import("./worker.js"),
  name: "agent-device",
};
