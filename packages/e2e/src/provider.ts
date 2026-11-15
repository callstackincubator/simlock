import type { DeviceProvider } from "@e2e-dev/mobile";
import type { createAgentDeviceClient } from "agent-device";

import type { ProviderOptions } from "./options.js";

export type AgentDeviceClientFactory = typeof createAgentDeviceClient;

export function createProvider(
  _options: ProviderOptions,
  _loadClient: () => Promise<AgentDeviceClientFactory>,
): DeviceProvider {
  // why: acquire and release come with the provider's next task; the factory is what this one ships.
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error("simlock: not implemented"));
  return { name: "simlock", acquire: notImplemented, release: notImplemented };
}
