import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import type { ProcessRunner } from "../../ports/index.js";
import { Catalog } from "./catalog.js";
import type { DeviceProfileSourceDiagnostic } from "./device-profile-source.js";
import { SystemImages } from "./system-images.js";
import { LIBRARY_PROFILES } from "./profiles/index.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  customDeviceXml,
  pixelDevices,
  processResult,
  twoPixelDevices,
  writeDevicesXml,
} from "./testing.js";

const avdmanager = `${sdk}/cmdline-tools/latest/bin/avdmanager`;
const binaries = { avdmanager, sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager` } as const;
const libraryModels = LIBRARY_PROFILES.map((profile) => profile.name);

function libraryAliases(extra: Record<string, string[]>): Record<string, string[]> {
  return { ...Object.fromEntries(LIBRARY_PROFILES.map((p) => [p.name, [p.id]])), ...extra };
}

function libraryClasses(extra: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(LIBRARY_PROFILES.map((p) => [p.name, p.deviceClass])), ...extra };
}

const withoutNonPhoneImages: Record<string, string[]> = {
  "Automotive (1024p landscape)": [],
  "Automotive (1080p landscape)": [],
  "Medium Desktop": [],
  "Large Desktop": [],
  "Television (1080p)": [],
  "Television (4K)": [],
  "Wear OS Large Round": [],
  "Wear OS Small Round": [],
};

function libraryRuntimes(
  runtimes: string[],
  extra: Record<string, string[]>,
): Record<string, string[]> {
  return { ...Object.fromEntries(LIBRARY_PROFILES.map((p) => [p.name, runtimes])), ...extra };
}

class ReversedReaddirFilesystem extends MemoryFilesystem {
  override async readdir(path: string): Promise<string[]> {
    return (await super.readdir(path)).reverse();
  }
}

async function androidFilesystem(
  options: { readonly images?: readonly (readonly [string, string, string])[] } = {},
  filesystem: MemoryFilesystem = new MemoryFilesystem(),
): Promise<MemoryFilesystem> {
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
  }
  return filesystem;
}

function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly onDiagnostic?: (diagnostic: DeviceProfileSourceDiagnostic) => void;
  } = {},
): Catalog {
  return new Catalog({
    avdmanager,
    avdmanagerEnv: () => ({ ANDROID_HOME: sdk }),
    env: { ANDROID_HOME: sdk, ...options.extraEnv },
    filesystem,
    homeDirectory: home,
    onDiagnostic: options.onDiagnostic,
    processRunner,
    sdkRoot: sdk,
    systemImages: new SystemImages({
      acceptAndroidLicenses: false,
      clock: new FakeClock(),
      deviceRoot: `${home}/.simlock/devices/android`,
      filesystem,
      hostAbi: "arm64-v8a",
      legacyAvdHome: `${home}/.android/avd`,
      processRunner,
      sdk: {
        adb: `${sdk}/platform-tools/adb`,
        emulator: `${sdk}/emulator/emulator`,
        root: sdk,
        sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
      },
    }),
  });
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Catalog` directly over a memory filesystem and a scripted `avdmanager`.
describe("Catalog", () => {
  it("resolves the newest installed matching image", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["34", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
        ["35", "google_apis", "x86_64"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = createPart(filesystem, runner);

    await expect(part.resolveSpec({ model: "Pixel 5", platform: "android" })).resolves.toEqual({
      physical: false,
      model: "Pixel 5",
      osVersion: "35",
      platform: "android",
    });
  });

  it("rejects a missing image naming its API level as the component, and starts no sdkmanager", async () => {
    const filesystem = await androidFilesystem();
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    await expect(
      part.resolveSpec({
        model: "Pixel 5",
        osVersion: "35",
        platform: "android",
      }),
    ).rejects.toMatchObject({ component: "35", downloadable: true, name: "RuntimeMissingError" });
    expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
  });

  it("lists resolvable models and installed API levels, defaulting to the newest", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["34", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
        ["35", "google_apis", "x86_64"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    // why: Strict: with no custom device profile there is no `customModels` key at all, not one
    // present as undefined.
    await expect(part.listCatalog()).resolves.toStrictEqual({
      defaultRuntime: "35",
      images: [
        { abi: "x86_64", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ],
      modelAliases: libraryAliases({ "Pixel 5": ["pixel_5"] }),
      modelClasses: libraryClasses({ "Pixel 5": "phone" }),
      modelRuntimes: libraryRuntimes(["34", "35"], {
        ...withoutNonPhoneImages,
        "Pixel 5": ["34", "35"],
        "Pixel 9": ["35"],
        "Pixel 9 Pro XL": ["35"],
      }),
      models: [...libraryModels, "Pixel 5"],
      runtimes: ["34", "35"],
    });
  });

  it("pairs a model with an installed API level whose only image has a foreign ABI, when the image fits", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["33", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5"]);
    expect(catalog.modelRuntimes).toEqual(
      libraryRuntimes(["33", "35"], {
        ...withoutNonPhoneImages,
        "Pixel 5": ["33", "35"],
        "Pixel 8": ["35"],
        "Pixel 9": ["35"],
        "Pixel 9 Pro XL": ["35"],
      }),
    );
  });

  it("reports no default runtime and no installed API levels without system images", async () => {
    const filesystem = await androidFilesystem({ images: [] });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    await expect(part.listCatalog()).resolves.toEqual({
      defaultRuntime: undefined,
      images: [],
      modelAliases: libraryAliases({ "Pixel 5": ["pixel_5"] }),
      modelClasses: libraryClasses({ "Pixel 5": "phone" }),
      modelRuntimes: libraryRuntimes([], { "Pixel 5": [] }),
      models: [...libraryModels, "Pixel 5"],
      runtimes: [],
    });
  });

  it("lists a built-in profile's avdmanager id as another name for its model", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const part = await createPart(await androidFilesystem(), runner);

    const catalog = await part.listCatalog();

    expect(catalog.modelAliases).toEqual(libraryAliases({ "Pixel 5": ["pixel_5"] }));
  });

  it("lists no other name when the id equals the display name ignoring case", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(
        binaries.avdmanager,
        ["list", "device"],
        `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n---------\n` +
          `id: 1 or "Automotive_1024p"\n    Name: automotive_1024p\n`,
      ),
    ]);
    const part = await createPart(await androidFilesystem(), runner);

    const catalog = await part.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5", "automotive_1024p"]);
    expect(catalog.modelAliases).toEqual(libraryAliases({ "Pixel 5": ["pixel_5"] }));
  });

  it("resolves every listed name of every listed model, in upper and lower case, to that model", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["36", "google_apis", "arm64-v8a"],
        ["36", "android-tv", "arm64-v8a"],
        ["36", "android-wear", "arm64-v8a"],
        ["36", "android-automotive", "arm64-v8a"],
        ["36", "android-automotive-playstore", "arm64-v8a"],
        ["36", "android-desktop", "arm64-v8a"],
      ],
    });
    await writeDevicesXml(filesystem, customDeviceXml("My Tablet", 4096));
    const runner = new ScriptedProcessRunner(
      Array.from({ length: 11 }, () =>
        processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      ),
    );
    const part = await createPart(filesystem, runner);
    const catalog = await part.listCatalog();
    const names = catalog.models.flatMap((model) => [
      { model, name: model },
      ...(catalog.modelAliases[model] ?? []).map((name) => ({ model, name })),
    ]);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContainEqual({ model: "Pixel 5", name: "pixel_5" });
    expect(names).toContainEqual({ model: "Pixel 5", name: "Pixel 5" });
    expect(names).toContainEqual({ model: "My Tablet", name: "My Tablet" });

    for (const { model, name } of names) {
      for (const spelling of [name.toUpperCase(), name.toLowerCase()]) {
        await expect(part.resolveSpec({ model: spelling, platform: "android" })).resolves.toEqual({
          physical: false,
          model,
          osVersion: "36",
          platform: "android",
        });
      }
    }
  });

  it("lists the same models as before other names were listed, for the same profiles", async () => {
    // why: A devices.xml profile named after a built-in id stays listed, and one whose name repeats a
    // built-in name in other letter case does not: both exactly as before this catalog listed
    // other names.
    const filesystem = await androidFilesystem();
    await writeDevicesXml(
      filesystem,
      customDeviceXml("pixel_5", 4096) +
        customDeviceXml("PIXEL 9", 4096) +
        customDeviceXml("My Tablet", 4096),
    );
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5", "pixel_5", "My Tablet"]);
    expect(Object.keys(catalog.modelRuntimes)).toEqual(catalog.models);
  });

  it("marks a model that comes only from devices.xml as custom, and no built-in model", async () => {
    const filesystem = await androidFilesystem();
    await writeDevicesXml(filesystem, customDeviceXml("My Tablet", 4096));
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5", "My Tablet"]);
    expect(catalog.customModels).toEqual(["My Tablet"]);
  });

  it("lists the built-in models and no customModels field when devices.xml cannot be parsed", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${home}/.android`);
    await filesystem.writeFileAtomic(`${home}/.android/devices.xml`, "not xml at all {{{");
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5"]);
    expect(catalog).not.toHaveProperty("customModels");
  });

  it("lists models with one avdmanager run", async () => {
    // why: A second answer is scripted, so a second run would be served and counted, not refused.
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const part = await createPart(await androidFilesystem(), runner);

    const catalog = await part.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5"]);
    expect(catalog.modelAliases).toEqual(libraryAliases({ "Pixel 5": ["pixel_5"] }));
    expect(runner.calls.filter((call) => call.command === binaries.avdmanager)).toHaveLength(1);
  });

  it("lists every installed system image with its API level, tag, and ABI, a foreign-ABI image included", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["35", "google_apis_playstore", "arm64-v8a"],
        ["33", "default", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.images).toEqual([
      { abi: "x86_64", runtime: "33", tag: "default" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis_playstore" },
    ]);
    expect(catalog.runtimes).toEqual(["33", "35"]);
  });

  it("lists images by API level, then tag, then ABI, whatever order the disk returns them in", async () => {
    // why: Directory listings come back in reverse, so a list read straight off the disk would be in
    // exactly the wrong order at every level.
    const filesystem = await androidFilesystem(
      {
        images: [
          ["9", "google_apis", "x86_64"],
          ["10", "default", "x86_64"],
          ["10", "google_apis", "arm64-v8a"],
          ["10", "google_apis", "x86_64"],
        ],
      },
      new ReversedReaddirFilesystem(),
    );
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.images).toEqual([
      { abi: "x86_64", runtime: "9", tag: "google_apis" },
      { abi: "x86_64", runtime: "10", tag: "default" },
      { abi: "arm64-v8a", runtime: "10", tag: "google_apis" },
      { abi: "x86_64", runtime: "10", tag: "google_apis" },
    ]);
  });

  it("does not list a dot entry under system-images as a tag or an ABI", async () => {
    const filesystem = await androidFilesystem({ images: [["34", "google_apis", "arm64-v8a"]] });
    await filesystem.writeFileAtomic(`${sdk}/system-images/android-34/.DS_Store`, "");
    await filesystem.writeFileAtomic(`${sdk}/system-images/android-34/google_apis/.DS_Store`, "");
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }]);
  });

  it("does not list an image that is not installed, even one sdkmanager offers", async () => {
    // why: Only API 34 is installed. An API 35 image is one `sdkmanager` run away, and the part
    // would install it for a lease that allows downloads; the catalog never asks `sdkmanager`
    // and lists the image on disk only. That no download policy reaches `listCatalog` is
    // proved in the dispatcher's tests.
    const filesystem = await androidFilesystem({ images: [["34", "google_apis", "arm64-v8a"]] });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(
        binaries.sdkmanager,
        ["--list"],
        "Available Packages:\n  system-images;android-35;google_apis;arm64-v8a | 1 | Google APIs\n",
      ),
    ]);
    const part = await createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }]);
    expect(runner.calls.some((call) => call.command === binaries.sdkmanager)).toBe(false);
  });
});
