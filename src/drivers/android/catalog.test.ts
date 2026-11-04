import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import type { ProcessRunner, ScriptedProcessExpectation } from "../../ports/index.js";
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
    readonly avdmanager?: string;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly onDiagnostic?: (diagnostic: DeviceProfileSourceDiagnostic) => void;
  } = {},
): Catalog {
  return new Catalog({
    avdmanager: options.avdmanager ?? avdmanager,
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
      hostAbi: options.hostAbi ?? "arm64-v8a",
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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(await androidFilesystem(), runner);

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
    const part = createPart(await androidFilesystem(), runner);

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
    const part = createPart(filesystem, runner);
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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(await androidFilesystem(), runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

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
    const part = createPart(filesystem, runner);

    const catalog = await part.listCatalog();

    expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }]);
    expect(runner.calls.some((call) => call.command === binaries.sdkmanager)).toBe(false);
  });

  describe("image tag", () => {
    async function taggedHarness(
      images: readonly (readonly [string, string, string])[],
      hostAbi = "arm64-v8a",
    ) {
      const filesystem = await androidFilesystem({ images });
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      const part = createPart(filesystem, runner, { hostAbi });
      return { part, runner };
    }

    it("fails a tag that is not installed for the API level as a runtime that cannot be downloaded, naming the tag, and starts no sdkmanager", async () => {
      const { part, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["35", "google_apis_playstore", "arm64-v8a"],
      ]);

      const failure = await part
        .resolveSpec({
          imageTag: "google_apis_playstore",
          model: "Pixel 5",
          osVersion: "34",
          platform: "android",
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
      expect((failure as Error).message).toContain("google_apis_playstore");
      expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
    });

    it("gives a tagged request with no API level the newest API level that has an image of that tag", async () => {
      const { part } = await taggedHarness([
        ["33", "google_apis_playstore", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["35", "google_apis", "arm64-v8a"],
      ]);

      await expect(
        part.resolveSpec({
          imageTag: "google_apis_playstore",
          model: "Pixel 5",
          platform: "android",
        }),
      ).resolves.toMatchObject({ imageTag: "google_apis_playstore", osVersion: "34" });
    });

    it("fails a tag installed for no API level, with no API level named, naming the tag and no API level", async () => {
      const { part } = await taggedHarness([["34", "google_apis", "arm64-v8a"]]);

      const failure = await part
        .resolveSpec({ imageTag: "google_apis_playstore", model: "Pixel 5", platform: "android" })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        component: undefined,
        downloadable: false,
        message: "No google_apis_playstore system image is installed for any Android API level",
        name: "RuntimeMissingError",
      });
    });
  });

  describe("avdmanager list device reads", () => {
    const toolsPackage = `${sdk}/cmdline-tools/latest`;
    const sdklibJar = `${toolsPackage}/lib/sdklib/sdklib.core.jar`;
    const userDevicesXml = `${home}/.android/devices.xml`;
    const imageDevicesXml = `${sdk}/system-images/android-34/google_apis/arm64-v8a/devices.xml`;
    const addOnDevicesXml = `${sdk}/add-ons/addon-acme/devices.xml`;
    const extraDirectory = `${sdk}/extras/acme/device_profiles`;
    const extraDevicesXml = `${extraDirectory}/devices.xml`;
    const rereadDevices = `Available devices:\nid: 0 or "reread_phone"\n    Name: Reread Phone\n    OEM : Acme\n`;

    /** why: sdklib reads `extras/<vendor>/<item>/devices.xml` only when the item's source.properties says `Extra.Path=DeviceProfiles`. */
    async function profilesExtra(filesystem: MemoryFilesystem, devicesXml?: string): Promise<void> {
      await filesystem.mkdirp(extraDirectory);
      await filesystem.writeFileAtomic(
        `${extraDirectory}/source.properties`,
        "Pkg.Revision=1\nExtra.Path=DeviceProfiles\n",
      );
      if (devicesXml !== undefined) await filesystem.writeFileAtomic(extraDevicesXml, devicesXml);
    }

    /** why: every input the read is keyed on is present, so a change to any of them is a change, not a creation. */
    async function readsHarness(
      options: {
        readonly avdmanager?: string;
        readonly before?: (filesystem: MemoryFilesystem) => Promise<void>;
        readonly results?: readonly ScriptedProcessExpectation[];
      } = {},
    ) {
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${toolsPackage}/lib/sdklib`);
      await filesystem.writeFileAtomic(sdklibJar, "jar");
      await filesystem.writeFileAtomic(`${toolsPackage}/source.properties`, "Pkg.Revision=20.0\n");
      await filesystem.writeFileAtomic(imageDevicesXml, "<d:devices/>");
      await filesystem.mkdirp(`${sdk}/add-ons/addon-acme`);
      await filesystem.writeFileAtomic(addOnDevicesXml, "<d:devices/>");
      await options.before?.(filesystem);
      const avdmanager = options.avdmanager ?? binaries.avdmanager;
      const runner = new ScriptedProcessRunner(
        options.results ?? [
          processResult(avdmanager, ["list", "device"], pixelDevices),
          processResult(avdmanager, ["list", "device"], rereadDevices),
        ],
      );
      const part = createPart(filesystem, runner, { avdmanager });
      const listRuns = () =>
        runner.calls.filter(
          (call) => call.command === avdmanager && call.args.join(" ") === "list device",
        );
      return { part, filesystem, listRuns, runner };
    }

    it("runs `avdmanager list device` once, with a 30 s limit, for two catalogs read while none of its inputs changed", async () => {
      const { part, listRuns } = await readsHarness();

      const first = await part.listCatalog();
      const second = await part.listCatalog();

      expect(first.models).toContain("Pixel 5");
      expect(second.models).toContain("Pixel 5");
      expect(second.models).not.toContain("Reread Phone");
      expect(listRuns()).toHaveLength(1);
      expect(listRuns()[0]?.options.timeoutMs).toBe(30_000);
    });

    it("runs `avdmanager list device` again after any file it reads device profiles from changed", async () => {
      const legacyTools = `${sdk}/tools`;
      const legacyJar = `${legacyTools}/lib/sdklib-26.0.0-dev.jar`;
      const cases: readonly {
        readonly change: string;
        readonly avdmanager?: string;
        readonly before?: (filesystem: MemoryFilesystem) => Promise<void>;
        readonly act: (filesystem: MemoryFilesystem) => Promise<void>;
      }[] = [
        {
          act: async (filesystem) =>
            filesystem.defineAttributes(sdklibJar, { modifiedAtMs: 5_000 }),
          change: "the sdklib jar's modified time",
        },
        {
          act: async (filesystem) => filesystem.writeFileAtomic(sdklibJar, "jar, updated"),
          change: "the sdklib jar's size",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(
              `${toolsPackage}/source.properties`,
              "Pkg.Revision=21.0.1\n",
            ),
          change: "the command-line tools' source.properties",
        },
        {
          act: async (filesystem) => writeDevicesXml(filesystem, customDeviceXml("Made", 2048)),
          change: "devices.xml created",
        },
        {
          act: async (filesystem) =>
            writeDevicesXml(
              filesystem,
              customDeviceXml("Kept", 2048) + customDeviceXml("New", 2048),
            ),
          before: async (filesystem) => writeDevicesXml(filesystem, customDeviceXml("Kept", 2048)),
          change: "devices.xml edited",
        },
        {
          act: async (filesystem) => filesystem.rm(userDevicesXml),
          before: async (filesystem) => writeDevicesXml(filesystem, customDeviceXml("Kept", 2048)),
          change: "devices.xml deleted",
        },
        {
          act: async (filesystem) =>
            filesystem.mkdirp(`${sdk}/system-images/android-35/google_apis/arm64-v8a`),
          change: "a system image installed",
        },
        {
          act: async (filesystem) => {
            await filesystem.mkdirp(`${sdk}/system-images/android-36/android-wear/arm64-v8a`);
            await filesystem.writeFileAtomic(
              `${sdk}/system-images/android-36/android-wear/arm64-v8a/devices.xml`,
              "<d:devices/>",
            );
          },
          change: "a system image installed with its own devices.xml",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(imageDevicesXml, "<d:devices></d:devices>"),
          change: "an installed system image's devices.xml",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(addOnDevicesXml, "<d:devices></d:devices>"),
          change: "an add-on's devices.xml",
        },
        {
          act: async (filesystem) => filesystem.writeFileAtomic(extraDevicesXml, "<d:devices/>"),
          before: async (filesystem) => profilesExtra(filesystem),
          change: "an extra's devices.xml created",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(extraDevicesXml, "<d:devices></d:devices>"),
          before: async (filesystem) => profilesExtra(filesystem, "<d:devices/>"),
          change: "an extra's devices.xml edited",
        },
        {
          act: async (filesystem) => filesystem.rm(extraDevicesXml),
          before: async (filesystem) => profilesExtra(filesystem, "<d:devices/>"),
          change: "an extra's devices.xml removed",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(
              `${extraDirectory}/source.properties`,
              "Extra.Path=DeviceProfiles\n",
            ),
          before: async (filesystem) => {
            await profilesExtra(filesystem, "<d:devices/>");
            await filesystem.writeFileAtomic(
              `${extraDirectory}/source.properties`,
              "Extra.Path=usb_driver\n",
            );
          },
          change: "an extra's source.properties made it a device-profiles extra",
        },
        {
          act: async (filesystem) => filesystem.writeFileAtomic(legacyJar, "legacy jar, updated"),
          avdmanager: `${legacyTools}/bin/avdmanager`,
          before: async (filesystem) => {
            await filesystem.rm(toolsPackage);
            await filesystem.mkdirp(`${legacyTools}/bin`);
            await filesystem.writeFileAtomic(`${legacyTools}/bin/avdmanager`, "binary");
            await filesystem.writeFileAtomic(`${legacyTools}/bin/sdkmanager`, "binary");
            await filesystem.mkdirp(`${legacyTools}/lib`);
            await filesystem.writeFileAtomic(legacyJar, "legacy jar");
          },
          change: "the legacy tools' sdklib jar",
        },
      ];

      const seen: Record<string, readonly unknown[]> = {};
      for (const row of cases) {
        const { part, filesystem, listRuns } = await readsHarness({
          ...(row.avdmanager === undefined ? {} : { avdmanager: row.avdmanager }),
          ...(row.before === undefined ? {} : { before: row.before }),
        });
        const first = await part.listCatalog();
        await row.act(filesystem);
        const second = await part.listCatalog();
        seen[row.change] = [
          first.models.includes("Reread Phone"),
          second.models.includes("Reread Phone"),
          listRuns().length,
        ];
      }

      expect(seen).toEqual(Object.fromEntries(cases.map((row) => [row.change, [false, true, 2]])));
    });

    it("runs `avdmanager list device` again after a read that failed", async () => {
      const { part, listRuns } = await readsHarness({
        results: [
          {
            match: { args: ["list", "device"], command: binaries.avdmanager },
            result: { code: 1, stderr: "Error: could not read device definitions", stdout: "" },
          },
          processResult(binaries.avdmanager, ["list", "device"], rereadDevices),
        ],
      });

      await expect(part.listCatalog()).rejects.toThrow("could not read device definitions");
      const catalog = await part.listCatalog();

      expect(catalog.models).toContain("Reread Phone");
      expect(listRuns()).toHaveLength(2);
    });

    it("runs one `avdmanager list device` for two catalogs read at once", async () => {
      const scripted = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // why: the run stays in flight until both catalogs have asked, so the second cannot be served from a finished read.
      const runner: ProcessRunner = {
        run: async (command, args, options) => {
          await held;
          return scripted.run(command, args, options);
        },
        spawn: (command, args, options) => scripted.spawn(command, args, options),
        spawnStreaming: (command, args, options) => scripted.spawnStreaming(command, args, options),
      };
      const part = createPart(await androidFilesystem(), runner);

      const catalogs = Promise.allSettled([part.listCatalog(), part.listCatalog()]);
      // why: the filesystem fake settles in microtasks, so one macrotask lets both catalogs
      // reach the read before the first run ends.
      await new Promise((resolve) => setImmediate(resolve));
      release();

      expect(
        (await catalogs).map(
          (catalog) => catalog.status === "fulfilled" && catalog.value.models.includes("Pixel 5"),
        ),
      ).toEqual([true, true]);
      expect(scripted.calls.filter((call) => call.args.join(" ") === "list device")).toHaveLength(
        1,
      );
    });
  });

  describe("library catalog", () => {
    const classes: Record<string, string> = {
      "Automotive (1024p landscape)": "auto",
      "Automotive (1080p landscape)": "auto",
      "Large Desktop": "desktop",
      "Medium Desktop": "desktop",
      "Medium Phone": "phone",
      "Medium Tablet": "tablet",
      "Pixel 6": "phone",
      "Pixel 7": "phone",
      "Pixel 8": "phone",
      "Pixel 9": "phone",
      "Pixel 9 Pro XL": "phone",
      "Small Phone": "phone",
      "Television (1080p)": "tv",
      "Television (4K)": "tv",
      "Wear OS Large Round": "watch",
      "Wear OS Small Round": "watch",
    };

    it("surfaces malformed devices.xml as a diagnostic and falls through to UnknownModelError, never throwing from the parse itself", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${home}/.android`);
      await filesystem.writeFileAtomic(`${home}/.android/devices.xml`, "not xml at all {{{");
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      const diagnostics: DeviceProfileSourceDiagnostic[] = [];
      const part = createPart(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await expect(
        part.resolveSpec({
          model: "Nonexistent Model",
          osVersion: "34",
          platform: "android",
        }),
      ).rejects.toMatchObject({ name: "UnknownModelError" });

      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: "device-profile-source-unreadable" }),
      ]);
    });

    it("lists Pixel 9 first in the catalog, once, as `phone`, not custom, with `pixel_9` as its other name", async () => {
      const filesystem = await androidFilesystem();
      await writeDevicesXml(
        filesystem,
        customDeviceXml("pixel_9", 4096) + customDeviceXml("PIXEL 9", 4096),
      );
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      ]);
      const part = createPart(filesystem, runner);

      const catalog = await part.listCatalog();

      expect(catalog.models[0]).toBe("Pixel 9");
      expect(catalog.models.filter((model) => model.toLocaleLowerCase() === "pixel 9")).toEqual([
        "Pixel 9",
      ]);
      expect(catalog.modelClasses["Pixel 9"]).toBe("phone");
      expect(catalog.customModels ?? []).not.toContain("Pixel 9");
      expect(catalog.modelAliases["Pixel 9"]).toEqual(["pixel_9"]);
    });

    it("every library model resolves, and the catalog lists all 16 with their table classes, when `avdmanager list device` lists none of them", async () => {
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], "Available devices:\n"),
      ]);
      const part = createPart(
        await androidFilesystem({
          images: [
            ["36", "google_apis", "arm64-v8a"],
            ["36", "android-tv", "arm64-v8a"],
            ["36", "android-wear", "arm64-v8a"],
            ["36", "android-automotive", "arm64-v8a"],
            ["36", "android-automotive-playstore", "arm64-v8a"],
            ["36", "android-desktop", "arm64-v8a"],
          ],
        }),
        runner,
      );

      const catalog = await part.listCatalog();
      const resolved: string[] = [];
      for (const model of Object.keys(classes)) {
        resolved.push((await part.resolveSpec({ model, platform: "android" })).model);
      }

      expect(resolved).toEqual(Object.keys(classes));
      expect(Object.keys(classes).filter((model) => !catalog.models.includes(model))).toEqual([]);
      for (const [model, deviceClass] of Object.entries(classes)) {
        expect(catalog.modelClasses[model], model).toBe(deviceClass);
      }
      expect(catalog.modelAliases["Television (4K)"]).toEqual(["tv_4k"]);
    });

    it("the catalog classes Medium Tablet `tablet` when `avdmanager list device` also lists `medium_tablet`", async () => {
      const listing =
        'Available devices:\nid: 0 or "medium_tablet"\n    Name: Medium Tablet\n    OEM : Generic\n';
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], listing),
      ]);
      const part = createPart(await androidFilesystem(), runner);

      const catalog = await part.listCatalog();

      expect(catalog.modelClasses["Medium Tablet"]).toBe("tablet");
      expect(catalog.models.filter((model) => model === "Medium Tablet")).toHaveLength(1);
    });
  });
});
