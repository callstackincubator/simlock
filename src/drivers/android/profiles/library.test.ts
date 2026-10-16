import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isPlayStoreImage } from "../image-fit.js";
import { LIBRARY_HARDWARE_KEYS } from "./hardware-keys.js";
import { LIBRARY_PROFILES, LibraryDeviceProfileSource } from "./index.js";

const folder = dirname(fileURLToPath(import.meta.url));
const NOT_PROFILE_FILES = new Set(["index.ts", "hardware-keys.ts"]);

function profileFiles(): string[] {
  return readdirSync(folder).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !NOT_PROFILE_FILES.has(file),
  );
}

function fixtureConfig(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(join(folder, "fixtures/pixel-9.config.ini"), "utf8").split(
    "\n",
  )) {
    const at = line.indexOf("=");
    if (at > 0) entries.set(line.slice(0, at), line.slice(at + 1));
  }
  return entries;
}

function isLibraryKey(key: string): boolean {
  return (
    (key.startsWith("hw.") || key === "vm.heapSize") &&
    key !== "hw.cpu.arch" &&
    key !== "hw.device.hash2"
  );
}

function pixel9() {
  const profile = LIBRARY_PROFILES.find((candidate) => candidate.id === "pixel_9");
  if (profile === undefined) throw new Error("the library has no profile with id pixel_9");
  return profile;
}

const TABLE = [
  ["pixel_8", "Pixel 8", "phone", undefined, 34, true, {}],
  ["pixel_7", "Pixel 7", "phone", undefined, 33, true, {}],
  ["pixel_6", "Pixel 6", "phone", undefined, 31, false, {}],
  ["medium_phone", "Medium Phone", "phone", undefined, 24, true, {}],
  ["small_phone", "Small Phone", "phone", undefined, 24, true, {}],
  ["pixel_9_pro_xl", "Pixel 9 Pro XL", "phone", undefined, 35, true, {}],
  ["medium_tablet", "Medium Tablet", "tablet", undefined, 24, true, {}],
  ["tv_1080p", "Television (1080p)", "tv", "android-tv", 20, false, {}],
  ["tv_4k", "Television (4K)", "tv", "android-tv", 31, false, {}],
  [
    "wearos_large_round",
    "Wear OS Large Round",
    "watch",
    "android-wear",
    20,
    true,
    { "ro.emulator.circular": "true" },
  ],
  [
    "wearos_small_round",
    "Wear OS Small Round",
    "watch",
    "android-wear",
    20,
    true,
    { "ro.emulator.circular": "true" },
  ],
  [
    "automotive_1080p_landscape",
    "Automotive (1080p landscape)",
    "auto",
    "android-automotive",
    28,
    false,
    {},
  ],
  [
    "automotive_1024p_landscape",
    "Automotive (1024p landscape)",
    "auto",
    "android-automotive-playstore",
    28,
    true,
    {},
  ],
  ["desktop_medium", "Medium Desktop", "desktop", "android-desktop", 32, false, {}],
  ["desktop_large", "Large Desktop", "desktop", "android-desktop", 32, false, {}],
] as const;

function byId(id: string) {
  const profile = LIBRARY_PROFILES.find((candidate) => candidate.id === id);
  if (profile === undefined) throw new Error(`the library has no profile with id ${id}`);
  return profile;
}

describe("the Android device profile library", () => {
  it("LIBRARY_HARDWARE_KEYS equals the hw.* and vm.heapSize keys of the Pixel 9 fixture without hw.cpu.arch and hw.device.hash2", () => {
    const expected = [...fixtureConfig().keys()].filter(isLibraryKey).sort();

    expect(expected).toHaveLength(104);
    expect([...LIBRARY_HARDWARE_KEYS].sort()).toEqual(expected);
  });

  it("Pixel 9's hardware equals the values in the fixture config.ini", () => {
    const expected = Object.fromEntries([...fixtureConfig()].filter(([key]) => isLibraryKey(key)));

    expect(pixel9().hardware).toEqual(expected);
    expect(pixel9().hardware["hw.ramSize"]).toBe("2G");
  });

  it("Pixel 9's class, image kind, API range, Play Store and tablet flags and boot properties are phone, none, 35-, yes, no, none", () => {
    const profile = pixel9();

    expect(profile.name).toBe("Pixel 9");
    expect(profile.names).toEqual(["Pixel 9", "pixel_9"]);
    expect(profile.deviceClass).toBe("phone");
    expect(profile.imageKind).toBeUndefined();
    expect(profile.apiRange).toEqual({ min: 35 });
    expect(profile.playStore).toBe(true);
    expect(profile.tablet).toBe(false);
    expect(profile.bootProperties).toEqual({});
  });

  it("the library holds exactly the 16 profiles #485 lists, by name", () => {
    expect(LIBRARY_PROFILES.map((profile) => profile.name).sort()).toEqual(
      ["Pixel 9", ...TABLE.map((row) => row[1])].sort(),
    );
  });

  it("each profile's class, image kind, API range, Play Store flag and boot properties match the table", () => {
    for (const [id, name, deviceClass, imageKind, min, playStore, bootProperties] of TABLE) {
      const profile = byId(id);
      expect(profile.name, id).toBe(name);
      expect(profile.deviceClass, id).toBe(deviceClass);
      expect(profile.imageKind, id).toBe(imageKind);
      expect(profile.apiRange, id).toEqual({ min });
      expect(profile.playStore, id).toBe(playStore);
      expect(profile.bootProperties, id).toEqual(bootProperties);
    }
  });

  it("Medium Tablet is the only profile marked tablet", () => {
    expect(LIBRARY_PROFILES.filter((profile) => profile.tablet).map((p) => p.name)).toEqual([
      "Medium Tablet",
    ]);
  });

  it("each profile answers to its id as its other name", () => {
    for (const [id, name] of TABLE) {
      expect(byId(id).names, id).toEqual([name, id]);
    }
  });

  it("the two round Wear profiles set hw.lcd.circular=true", () => {
    expect(byId("wearos_large_round").hardware["hw.lcd.circular"]).toBe("true");
    expect(byId("wearos_small_round").hardware["hw.lcd.circular"]).toBe("true");
  });

  it("the source lists exactly the profiles the library holds", async () => {
    const listed = await new LibraryDeviceProfileSource().profiles();

    expect(LIBRARY_PROFILES.length).toBeGreaterThan(0);
    expect(listed).toEqual(LIBRARY_PROFILES);
  });

  it("index.ts imports exactly the profile files in the folder", () => {
    const files = profileFiles();
    const imported = [
      ...readFileSync(join(folder, "index.ts"), "utf8").matchAll(/from "\.\/([^"]+)\.js"/g),
    ]
      .map((match) => `${match[1] ?? ""}.ts`)
      .filter((file) => !NOT_PROFILE_FILES.has(file));

    expect(files.length).toBeGreaterThan(0);
    expect(imported.sort()).toEqual(files.sort());
  });

  it("each profile file is named after its id with - for _", () => {
    expect(LIBRARY_PROFILES.length).toBeGreaterThan(0);
    const expected = LIBRARY_PROFILES.map((profile) => `${profile.id.replaceAll("_", "-")}.ts`);

    expect(expected.sort()).toEqual(profileFiles().sort());
  });

  it("no name, ignoring case, appears in two profiles", () => {
    const names = LIBRARY_PROFILES.flatMap((profile) =>
      profile.names.map((name) => name.toLocaleLowerCase()),
    );

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every profile sets every key in LIBRARY_HARDWARE_KEYS, and only hw.* and vm.heapSize keys other than hw.cpu.arch and hw.device.hash2", () => {
    expect(LIBRARY_HARDWARE_KEYS.length).toBeGreaterThan(0);
    expect(LIBRARY_PROFILES.length).toBeGreaterThan(0);
    for (const profile of LIBRARY_PROFILES) {
      const keys = Object.keys(profile.hardware);
      expect(
        keys.filter((key) => !isLibraryKey(key)),
        profile.id,
      ).toEqual([]);
      expect(
        LIBRARY_HARDWARE_KEYS.filter((key) => !keys.includes(key)),
        profile.id,
      ).toEqual([]);
    }
  });

  it("every profile names the cmdline-tools version it was copied from", () => {
    expect(LIBRARY_PROFILES.length).toBeGreaterThan(0);
    for (const profile of LIBRARY_PROFILES) {
      expect(profile.copiedFrom, profile.id).toMatch(/^\d+\.\d+$/);
    }
  });
});

describe("isPlayStoreImage", () => {
  const image = (tag: string, tags: readonly string[], apiLevel = "35") => ({
    apiLevel,
    tag,
    tags,
  });

  it("is true for a google_apis_playstore tag, a single android-automotive-playstore tag and a single android-wear tag at 25 or newer", () => {
    expect(isPlayStoreImage(image("google_apis_playstore", ["google_apis_playstore"]))).toBe(true);
    expect(isPlayStoreImage(image("x", ["google-tv", "google_apis_playstore"]))).toBe(true);
    expect(
      isPlayStoreImage(image("android-automotive-playstore", ["android-automotive-playstore"])),
    ).toBe(true);
    expect(isPlayStoreImage(image("android-wear", ["android-wear"], "25"))).toBe(true);
    expect(isPlayStoreImage(image("android-wear", ["android-wear"], "34"))).toBe(true);
  });

  it("is false for android-wear at 24, android-wear-cn, google_apis and google-tv,google_apis", () => {
    expect(isPlayStoreImage(image("android-wear", ["android-wear"], "24"))).toBe(false);
    expect(isPlayStoreImage(image("android-wear-cn", ["android-wear"], "34"))).toBe(false);
    expect(isPlayStoreImage(image("google_apis", ["google_apis"]))).toBe(false);
    expect(isPlayStoreImage(image("google-tv", ["google-tv", "google_apis"]))).toBe(false);
  });
});

describe("the Android device profile library, automotive second display", () => {
  it("both automotive profiles carry the SDK's hw.display6 lines: density 120, flag 0, height 600, width 400", () => {
    for (const id of ["automotive_1024p_landscape", "automotive_1080p_landscape"]) {
      const hardware = byId(id).hardware;
      expect(
        [
          hardware["hw.display6.density"],
          hardware["hw.display6.flag"],
          hardware["hw.display6.height"],
          hardware["hw.display6.width"],
        ],
        id,
      ).toEqual(["120", "0", "600", "400"]);
    }
  });
});
