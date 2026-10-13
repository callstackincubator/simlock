import { describe, expect, it } from "vitest";

import type { DeviceProfile } from "./device-profile-source.js";
import { fits, type ImageFitInput } from "./image-fit.js";
import { LIBRARY_PROFILES } from "./profiles/index.js";

function library(id: string) {
  const profile = LIBRARY_PROFILES.find((candidate) => candidate.id === id);
  if (profile === undefined) throw new Error(`the library has no profile with id ${id}`);
  return profile;
}

function image(apiLevel: string, tag: string, extra: Partial<ImageFitInput> = {}): ImageFitInput {
  return { apiLevel, tag, tags: [tag], ...extra };
}

function builtin(id: string, tag: string | undefined, custom = false): DeviceProfile {
  return {
    avdmanagerId: id,
    custom,
    deviceClass: undefined,
    kind: "builtin",
    name: id,
    names: [id],
    ...(tag === undefined ? {} : { tag }),
  };
}

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

describe("fits", () => {
  it("a TV profile fits android-tv and google-tv images and no phone image", () => {
    const tv = library("tv_1080p");

    expect(fits(tv, image("34", "android-tv"))).toBe(true);
    expect(fits(tv, image("34", "google-tv"))).toBe(true);
    expect(fits(tv, image("34", "google_apis"))).toBe(false);
    expect(fits(tv, image("34", "default"))).toBe(false);
  });

  it.each([
    ["wearos_large_round", "android-wear"],
    ["automotive_1080p_landscape", "android-automotive"],
    ["desktop_medium", "android-desktop"],
  ])("the %s profile fits only images with its exact tag", (id, tag) => {
    const profile = library(id);

    expect(fits(profile, image("34", tag))).toBe(true);
    expect(fits(profile, image("34", "google_apis"))).toBe(false);
    expect(fits(profile, image("34", "android-tv"))).toBe(false);
  });

  it.each(["android-automotive-playstore", "android-automotive-distantdisplay"])(
    "the android-automotive tag does not fit an image tagged %s that shares its prefix",
    (tag) => {
      expect(fits(builtin("auto", "android-automotive"), image("34", tag))).toBe(false);
    },
  );

  it.each(NON_PHONE_TAGS)("a profile with no kind does not fit a %s image", (tag) => {
    expect(fits(library("medium_phone"), image("34", "google_apis"))).toBe(true);
    expect(fits(library("medium_phone"), image("34", tag))).toBe(false);
  });

  it("an image below a profile's API range does not fit", () => {
    const pixel9 = library("pixel_9");

    expect(fits(pixel9, image("35", "google_apis"))).toBe(true);
    expect(fits(pixel9, image("34", "google_apis"))).toBe(false);
  });

  it("an image above a profile's API range max does not fit", () => {
    const bounded = { ...library("medium_phone"), apiRange: { max: 33, min: 24 } };

    expect(fits(bounded, image("33", "google_apis"))).toBe(true);
    expect(fits(bounded, image("34", "google_apis"))).toBe(false);
  });

  it("a 36.1 folder level counts as 36", () => {
    const capped = { ...library("medium_phone"), apiRange: { max: 36, min: 36 } };

    expect(fits(capped, image("36.1", "google_apis"))).toBe(true);
    expect(fits(capped, image("37.1", "google_apis"))).toBe(false);
  });

  it("android-Baklava with AndroidVersion.ApiLevel=35 fits Pixel 9", () => {
    const pixel9 = library("pixel_9");

    expect(fits(pixel9, image("Baklava", "google_apis", { sourceApiLevel: "35" }))).toBe(true);
    expect(fits(pixel9, image("Baklava", "google_apis", { sourceApiLevel: "34" }))).toBe(false);
  });

  it("an image with no number fits only a profile with no range", () => {
    const unnumbered = image("Baklava", "google_apis");

    expect(fits(library("pixel_9"), unnumbered)).toBe(false);
    expect(fits(builtin("pixel_9_pro", undefined), unnumbered)).toBe(true);
  });

  it.each(["ai-glasses", "android-xr-glasses"])(
    "a profile tagged %s fits both glasses image tags and no phone image",
    (profileTag) => {
      const glasses = builtin("glasses", profileTag);

      expect(fits(glasses, image("36", "ai-glasses"))).toBe(true);
      expect(fits(glasses, image("36", "android-xr-glasses"))).toBe(true);
      expect(fits(glasses, image("36", "google_apis"))).toBe(false);
    },
  );

  it("xr_glasses_device fits only android-xr-ost", () => {
    const xr = builtin("xr_glasses_device", "android-xr-glasses");

    expect(fits(xr, image("36", "android-xr-ost"))).toBe(true);
    expect(fits(xr, image("36", "ai-glasses"))).toBe(false);
    expect(fits(xr, image("36", "android-xr-glasses"))).toBe(false);
  });

  it("a phone profile fits an android-xr-ost image", () => {
    expect(fits(library("medium_phone"), image("36", "android-xr-ost"))).toBe(true);
  });

  it("a Play Store image does not fit a profile that disallows Play Store", () => {
    const playStore = image("35", "google_apis_playstore");

    expect(fits(library("pixel_6"), playStore)).toBe(false);
    expect(fits(library("pixel_6"), image("35", "google_apis"))).toBe(true);
  });

  it("a Play Store image fits a profile that allows Play Store", () => {
    expect(fits(library("medium_phone"), image("35", "google_apis_playstore"))).toBe(true);
  });

  it("an Automotive (1024p landscape) profile fits a single-tag android-automotive-playstore image as a Play Store image", () => {
    const profile = library("automotive_1024p_landscape");
    const playStore = image("34", "android-automotive-playstore");

    expect(fits(profile, playStore)).toBe(true);
    expect(fits({ ...profile, playStore: false }, playStore)).toBe(false);
  });

  it("a tablet image fits only a tablet profile", () => {
    for (const tag of ["tablet", "aosp_tablet"]) {
      expect(fits(library("medium_tablet"), image("35", tag))).toBe(true);
      expect(fits(library("medium_phone"), image("35", tag))).toBe(false);
    }
  });

  it("an SDK or custom profile fits by its Tag value with no API range and Play Store allowed", () => {
    const tv = builtin("tv_sdk", "android-tv");
    const phone = builtin("My Phone", undefined, true);

    expect(fits(tv, image("19", "android-tv"))).toBe(true);
    expect(fits(tv, image("19", "google_apis"))).toBe(false);
    expect(fits(phone, image("19", "google_apis_playstore"))).toBe(true);
    expect(fits(phone, image("19", "android-tv"))).toBe(false);
    expect(fits(phone, image("19", "tablet"))).toBe(false);
  });

  it("a devices.xml profile avdmanager did not list fits every image", () => {
    const properties: DeviceProfile = {
      hardwareProperties: {},
      kind: "properties",
      name: "Legacy",
      names: ["Legacy"],
    };

    for (const tag of ["android-tv", "google_apis_playstore", "tablet", "android-wear"]) {
      expect(fits(properties, image("Baklava", tag))).toBe(true);
    }
  });
});
