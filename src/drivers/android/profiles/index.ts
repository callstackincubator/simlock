import type { DeviceProfile, DeviceProfileSource } from "../device-profile-source.js";
import { PIXEL_9 } from "./pixel-9.js";

export type LibraryDeviceProfile = Extract<DeviceProfile, { readonly kind: "library" }>;

export const LIBRARY_PROFILES: readonly LibraryDeviceProfile[] = [PIXEL_9];

export class LibraryDeviceProfileSource implements DeviceProfileSource {
  async profiles(): Promise<readonly DeviceProfile[]> {
    return LIBRARY_PROFILES;
  }
}
