import type {
  DeviceInputFactory,
  PhysicalDriverDevice,
  VirtualDriverDevice,
} from "../../../core/index.js";
import type { Clock } from "../../../ports/index.js";
import type { ScreenTarget } from "../screen/index.js";

export interface AndroidDeviceInputOptions {
  readonly clock: Clock;
  readonly serverPath: string;
  readonly scid?: () => number;
  targetFor(device: VirtualDriverDevice | PhysicalDriverDevice): Promise<ScreenTarget>;
}

export function createAndroidDeviceInput(_options: AndroidDeviceInputOptions): DeviceInputFactory {
  return { open: async () => ({ unavailable: "" }) };
}
