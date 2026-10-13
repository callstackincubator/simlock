import type { DeviceProfile, DeviceProfileSource } from "../device-profile-source.js";

export type LibraryDeviceProfile = Extract<DeviceProfile, { readonly kind: "library" }>;

export const LIBRARY_PROFILES: readonly LibraryDeviceProfile[] = [];

export class LibraryDeviceProfileSource implements DeviceProfileSource {
  async profiles(): Promise<readonly DeviceProfile[]> {
    return LIBRARY_PROFILES;
  }
}
