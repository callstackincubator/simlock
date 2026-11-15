import type { DeviceProvider } from "@e2e-dev/mobile";

import { checkOptions, type SimlockDevicesOptions } from "./options.js";
import { createProvider } from "./provider.js";

export type { SimlockDevicesOptions } from "./options.js";

export function simlockDevices(options: SimlockDevicesOptions): DeviceProvider {
  return createProvider(
    checkOptions(options),
    async () => (await import("agent-device")).createAgentDeviceClient,
  );
}
