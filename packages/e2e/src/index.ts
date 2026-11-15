import type { DeviceProvider } from "@e2e-dev/mobile";

import type { SimlockDevicesOptions } from "./options.js";

export type { SimlockDevicesOptions } from "./options.js";

export function simlockDevices(_options: SimlockDevicesOptions): DeviceProvider {
  return { name: "" } as DeviceProvider;
}
