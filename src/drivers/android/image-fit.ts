import type { DeviceProfile } from "./device-profile-source.js";

export interface ImageFitInput {
  readonly apiLevel: string;
  readonly sourceApiLevel?: string | undefined;
  readonly tag: string;
  readonly tags: readonly string[];
}

const MIN_WEAR_PLAY_STORE_API = 25;

export function isPlayStoreImage(image: ImageFitInput): boolean {
  if (image.tags.includes("google_apis_playstore")) return true;
  const [only, ...rest] = image.tags;
  if (rest.length > 0) return false;
  if (only === "android-automotive-playstore") return true;
  return (
    only === "android-wear" &&
    image.tag !== "android-wear-cn" &&
    Number(image.apiLevel) >= MIN_WEAR_PLAY_STORE_API
  );
}

export function fits(_profile: DeviceProfile, _image: ImageFitInput): boolean {
  return true;
}
