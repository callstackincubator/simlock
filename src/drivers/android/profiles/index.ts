import type { DeviceProfile, DeviceProfileSource } from "../device-profile-source.js";
import { AUTOMOTIVE_1024P_LANDSCAPE } from "./automotive-1024p-landscape.js";
import { AUTOMOTIVE_1080P_LANDSCAPE } from "./automotive-1080p-landscape.js";
import { DESKTOP_LARGE } from "./desktop-large.js";
import { DESKTOP_MEDIUM } from "./desktop-medium.js";
import { MEDIUM_PHONE } from "./medium-phone.js";
import { MEDIUM_TABLET } from "./medium-tablet.js";
import { PIXEL_6 } from "./pixel-6.js";
import { PIXEL_7 } from "./pixel-7.js";
import { PIXEL_8 } from "./pixel-8.js";
import { PIXEL_9 } from "./pixel-9.js";
import { PIXEL_9_PRO_XL } from "./pixel-9-pro-xl.js";
import { SMALL_PHONE } from "./small-phone.js";
import { TV_1080P } from "./tv-1080p.js";
import { TV_4K } from "./tv-4k.js";
import { WEAROS_LARGE_ROUND } from "./wearos-large-round.js";
import { WEAROS_SMALL_ROUND } from "./wearos-small-round.js";

export type LibraryDeviceProfile = Extract<DeviceProfile, { readonly kind: "library" }>;

export const LIBRARY_PROFILES: readonly LibraryDeviceProfile[] = [
  PIXEL_9,
  PIXEL_8,
  PIXEL_7,
  PIXEL_6,
  MEDIUM_PHONE,
  SMALL_PHONE,
  PIXEL_9_PRO_XL,
  MEDIUM_TABLET,
  TV_1080P,
  TV_4K,
  WEAROS_LARGE_ROUND,
  WEAROS_SMALL_ROUND,
  AUTOMOTIVE_1080P_LANDSCAPE,
  AUTOMOTIVE_1024P_LANDSCAPE,
  DESKTOP_MEDIUM,
  DESKTOP_LARGE,
];

export class LibraryDeviceProfileSource implements DeviceProfileSource {
  async profiles(): Promise<readonly DeviceProfile[]> {
    return LIBRARY_PROFILES;
  }
}
