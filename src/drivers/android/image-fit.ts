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

type FitCheck = "apiRange" | "kind" | "playStore" | "tablet";

const FIT_CHECK_ORDER: readonly FitCheck[] = ["apiRange", "kind", "playStore", "tablet"];

const TV_TAGS = ["android-tv", "google-tv"];
const GLASSES_TAGS = ["ai-glasses", "android-xr-glasses"];
const XR_GLASSES_PROFILE_ID = "xr_glasses_device";
const TABLET_TAGS = ["tablet", "aosp_tablet"];

const NON_PHONE_TAGS = [
  "android-wear",
  "android-desktop",
  "android-tv",
  "google-tv",
  "android-automotive",
  "android-automotive-playstore",
  "android-automotive-distantdisplay",
  "android-xr",
  "android-xr-glasses",
  "ai-glasses",
  "chromeos",
];

interface ProfileFacts {
  readonly apiRange: { readonly min: number; readonly max?: number } | undefined;
  readonly kind: string | undefined;
  readonly playStore: boolean;
  readonly tablet: boolean;
  readonly profileId: string | undefined;
}

function factsOf(profile: DeviceProfile): ProfileFacts | undefined {
  switch (profile.kind) {
    case "library":
      return {
        apiRange: profile.apiRange,
        kind: profile.imageKind,
        playStore: profile.playStore,
        profileId: profile.id,
        tablet: profile.tablet,
      };
    case "builtin":
      return {
        apiRange: profile.apiRange,
        kind: profile.tag,
        playStore: profile.playStore !== false || profile.tag === "android-wear",
        profileId: profile.avdmanagerId,
        tablet: profile.tablet ?? false,
      };
    case "properties":
      return {
        apiRange: profile.apiRange,
        kind: profile.imageKind,
        playStore: profile.playStore ?? true,
        profileId: undefined,
        tablet: profile.tablet ?? false,
      };
  }
}

function imageApiLevel(image: ImageFitInput): number | undefined {
  for (const candidate of [image.sourceApiLevel, image.apiLevel]) {
    const match = /^(\d+)/.exec(candidate ?? "");
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

function kindFits(facts: ProfileFacts, image: ImageFitInput): boolean {
  const has = (tags: readonly string[]): boolean => tags.some((tag) => image.tags.includes(tag));
  const { kind } = facts;
  if (facts.profileId === XR_GLASSES_PROFILE_ID) return has(["android-xr-ost"]);
  if (kind === undefined) return !has(NON_PHONE_TAGS);
  if (TV_TAGS.includes(kind)) return has(TV_TAGS);
  if (GLASSES_TAGS.includes(kind)) return has(GLASSES_TAGS);
  return has([kind]);
}

// fallow-ignore-next-line complexity -- the four fit checks are one pass over one profile and image.
function failedChecks(profile: DeviceProfile, image: ImageFitInput): FitCheck[] {
  const facts = factsOf(profile);
  if (facts === undefined) return [];
  const failed = new Set<FitCheck>();
  if (facts.apiRange !== undefined) {
    const level = imageApiLevel(image);
    if (
      level === undefined ||
      level < facts.apiRange.min ||
      (facts.apiRange.max !== undefined && level > facts.apiRange.max)
    ) {
      failed.add("apiRange");
    }
  }
  if (!kindFits(facts, image)) failed.add("kind");
  if (!facts.playStore && isPlayStoreImage(image)) failed.add("playStore");
  if (!facts.tablet && image.tags.some((tag) => TABLET_TAGS.includes(tag))) failed.add("tablet");
  return FIT_CHECK_ORDER.filter((check) => failed.has(check));
}

export function fits(profile: DeviceProfile, image: ImageFitInput): boolean {
  return failedChecks(profile, image).length === 0;
}

function kindName(kind: string | undefined): string {
  if (kind === undefined) return "a phone or tablet image";
  if (TV_TAGS.includes(kind)) return "a TV image";
  if (kind === "android-wear") return "a Wear OS image";
  if (kind.startsWith("android-automotive")) return "an automotive image";
  if (kind === "android-desktop") return "a desktop image";
  if (kind.startsWith("android-xr") && !GLASSES_TAGS.includes(kind)) return "an XR image";
  if (GLASSES_TAGS.includes(kind)) return "an AI glasses image";
  return `an image tagged ${kind}`;
}

export function misfitReason(
  profile: DeviceProfile,
  images: readonly ImageFitInput[],
): string | undefined {
  const facts = factsOf(profile);
  if (facts === undefined || images.length === 0) return undefined;
  const failures = images.map((image) => failedChecks(profile, image));
  const check = FIT_CHECK_ORDER.find((candidate) =>
    failures.every((failed) => failed.includes(candidate)),
  );
  switch (check) {
    case "apiRange": {
      const range = facts.apiRange;
      const level = imageApiLevel(images[0] as ImageFitInput);
      if (range?.max !== undefined && level !== undefined && level > range.max) {
        return `it needs Android ${range.max} or older`;
      }
      return `it needs Android ${range?.min} or newer`;
    }
    case "kind":
      return `it needs ${kindName(facts.profileId === XR_GLASSES_PROFILE_ID ? "android-xr-ost" : facts.kind)}`;
    case "playStore":
      return `${profile.name} does not take Play Store images`;
    case "tablet":
      return `${profile.name} does not take tablet images`;
    case undefined:
      return undefined;
  }
}
