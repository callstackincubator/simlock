import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import type {
  ProcessHandle,
  ProcessRunner,
  ProcessRunOptions,
  ScriptedProcessExpectation,
} from "../../ports/index.js";
import { Catalog } from "./catalog.js";
import type {
  DeviceProfileSource,
  DeviceProfileSourceDiagnostic,
} from "./device-profile-source.js";
import { SystemImages } from "./system-images.js";
import { LIBRARY_PROFILES, type LibraryDeviceProfile } from "./profiles/index.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  customDeviceXml,
  customFitXml,
  fitDevices,
  type FitImage,
  HOST_IMAGES,
  pixelDevices,
  processResult,
  type Refusal,
  testLibraryProfile,
  twoPixelDevices,
  userListing,
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
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly onDiagnostic?: (diagnostic: DeviceProfileSourceDiagnostic) => void;
  } = {},
): Catalog {
  return new Catalog({
    avdmanager: options.avdmanager ?? avdmanager,
    avdmanagerEnv: () => ({ ANDROID_HOME: sdk }),
    deviceProfileSources: options.deviceProfileSources,
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

// why: the verbatim source.properties of the real android-Baklava image installed beside
// android-36 and android-37.0 on a reporting host, so the fixture holds what the SDK really stores.
const BAKLAVA_SOURCE_PROPERTIES =
  "Pkg.Desc=System Image arm64-v8a with Google APIs.\n" +
  "Pkg.Revision=4\n" +
  "AndroidVersion.ApiLevel=35\n" +
  "AndroidVersion.CodeName=Baklava\n" +
  "SystemImage.Abi=arm64-v8a\n" +
  "SystemImage.TagId=google_apis\n";

// why: `avdmanager list device` answers with the listing a test names however often it is asked, so a
// second read is counted rather than refused.
class ListingRunner extends ScriptedProcessRunner {
  constructor(private readonly listing: string) {
    super([]);
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    if (command === binaries.avdmanager && args[0] === "list") {
      return new ScriptedProcessRunner([processResult(command, args, this.listing)]).spawn(
        command,
        args,
        options,
      );
    }
    return super.spawn(command, args, options);
  }
}

async function fitHarness(
  images: readonly FitImage[],
  options: {
    readonly devicesXml?: string;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly listing?: string;
    readonly profiles?: readonly LibraryDeviceProfile[];
  } = {},
) {
  const filesystem = await androidFilesystem({
    images: images.map(([api, tag, abi]) => [api, tag, abi]),
  });
  for (const [api, tag, abi, properties] of images) {
    if (properties !== undefined) {
      await filesystem.writeFileAtomic(
        `${sdk}/system-images/android-${api}/${tag}/${abi}/source.properties`,
        properties,
      );
    }
  }
  if (options.devicesXml !== undefined) await writeDevicesXml(filesystem, options.devicesXml);
  const runner = new ListingRunner(options.listing ?? fitDevices);
  const part = createPart(filesystem, runner, {
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    hostAbi: options.hostAbi ?? "arm64-v8a",
    ...(options.profiles === undefined
      ? {}
      : { deviceProfileSources: [{ profiles: async () => options.profiles ?? [] }] }),
  });
  const resolve = (model: string, osVersion?: string, imageTag?: string) =>
    part.resolveSpec({
      model,
      platform: "android",
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(imageTag === undefined ? {} : { imageTag }),
    });
  const refusal = (model: string, osVersion?: string, imageTag?: string) =>
    resolve(model, osVersion, imageTag).then(
      () => {
        throw new Error(`${model} ${osVersion ?? ""} ${imageTag ?? ""} resolved`);
      },
      (error: unknown) => error as Refusal,
    );
  return { filesystem, part, refusal, resolve, runner };
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

  describe("each row of the In short table", () => {
    interface Row {
      readonly name: string;
      readonly images?: readonly FitImage[];
      readonly model: string;
      readonly os?: string;
      readonly tag?: string;
      readonly resolves?: string;
      readonly resolvedTag?: string;
      readonly refusedDownloadable?: boolean;
      readonly refusedComponent?: string;
      readonly pkg?: string;
    }
    const withGoogleTv: readonly FitImage[] = [...HOST_IMAGES, ["36", "google-tv", "arm64-v8a"]];
    const withWear: readonly FitImage[] = [...HOST_IMAGES, ["34", "android-wear", "arm64-v8a"]];
    const rows: readonly Row[] = [
      { model: "Television (1080p)", name: "TV 1080p", resolves: "34" },
      { model: "Television (1080p)", name: "TV 1080p at 36", os: "36", refusedDownloadable: false },
      {
        model: "Television (1080p)",
        name: "TV 1080p with image tag google_apis",
        refusedDownloadable: false,
        tag: "google_apis",
      },
      { model: "Television (720p)", name: "TV 720p, SDK only", resolves: "34" },
      {
        images: withGoogleTv,
        model: "Television (1080p)",
        name: "TV 1080p with a google-tv image at 36",
        resolves: "36",
      },
      { images: withWear, model: "Wear OS Large Round", name: "Wear OS", resolves: "34" },
      { model: "Pixel 9", name: "Pixel 9", resolves: "36" },
      { model: "Pixel 9", name: "Pixel 9 at 34", os: "34", refusedDownloadable: false },
      {
        model: "Pixel 9",
        name: "Pixel 9 at 37",
        os: "37",
        refusedComponent: "37",
        refusedDownloadable: true,
      },
      { model: "Television (1080p)", name: "TV 1080p at 37", os: "37", refusedDownloadable: false },
      { model: "Pixel 6", name: "Pixel 6", resolves: "35" },
      { model: "Pixel 6", name: "Pixel 6 at 36", os: "36", refusedDownloadable: false },
      {
        model: "Pixel 6",
        name: "Pixel 6 at 37",
        os: "37",
        refusedComponent: "37",
        refusedDownloadable: true,
      },
      {
        model: "Pixel 6",
        name: "Pixel 6 with image tag google_apis_playstore",
        refusedDownloadable: false,
        tag: "google_apis_playstore",
      },
      {
        model: "Medium Phone",
        name: "Medium Phone with image tag google_apis_playstore",
        resolvedTag: "google_apis_playstore",
        resolves: "36",
        tag: "google_apis_playstore",
      },
      { model: "Medium Phone", name: "Medium Phone at 35", os: "35", resolves: "35" },
      { model: "Pixel 9 Pro", name: "Pixel 9 Pro, SDK only", resolves: "36" },
      { model: "My Tablet", name: "My Tablet, custom", resolves: "36" },
    ];

    it.each(rows)("$name gives its After result", async (row) => {
      const { part, refusal, resolve } = await fitHarness(row.images ?? HOST_IMAGES);

      if (row.refusedDownloadable !== undefined) {
        expect(await refusal(row.model, row.os, row.tag)).toMatchObject({
          component: row.refusedComponent,
          downloadable: row.refusedDownloadable,
          name: "RuntimeMissingError",
        });
        if (row.os !== undefined) {
          expect((await part.listCatalog()).modelRuntimes[row.model]).not.toContain(row.os);
        }
        return;
      }
      const spec = await resolve(row.model, row.os, row.tag);
      expect(spec).toEqual({
        ...(row.resolvedTag === undefined ? {} : { imageTag: row.resolvedTag }),
        model: row.model,
        osVersion: row.resolves,
        physical: false,
        platform: "android",
      });
      expect((await part.listCatalog()).modelRuntimes[row.model]).toContain(spec.osVersion);
    });

    it("pairs My Tablet with 35 and 36 and not the TV image at 34, and the TV with 34 only", async () => {
      const { part } = await fitHarness(HOST_IMAGES);

      const { modelRuntimes } = await part.listCatalog();

      expect(modelRuntimes["My Tablet"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Television (1080p)"]).toEqual(["34"]);
      expect(modelRuntimes["Pixel 9"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Pixel 6"]).toEqual(["35"]);
    });
  });

  describe("downloads", () => {
    it("is not downloadable for an uninstalled level above the profile's API range", async () => {
      const old = await fitHarness([["35", "google_apis", "arm64-v8a"]], {
        profiles: [
          testLibraryProfile({
            apiRange: { max: 33, min: 24 },
            name: "Old Phone",
            names: ["Old Phone"],
          }),
        ],
      });
      expect((await old.refusal("Old Phone", "34")).downloadable).toBe(false);
    });
  });

  describe("the catalog", () => {
    it("lists in modelRuntimes only levels with a fitting image, and every installed image elsewhere", async () => {
      const { part } = await fitHarness([
        ["35", "google_apis", "arm64-v8a"],
        ["37", "android-xr", "arm64-v8a"],
      ]);

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Pixel 5"]).toEqual(["35"]);
      expect(catalog.modelRuntimes["Television (1080p)"]).toEqual([]);
      expect(catalog.runtimes).toEqual(["35", "37"]);
      expect(catalog.defaultRuntime).toBe("37");
      expect(catalog.images).toEqual([
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "37", tag: "android-xr" },
      ]);
    });

    it("resolves every pair it lists, and refuses a level it leaves out", async () => {
      const { part, refusal, resolve } = await fitHarness([
        ...HOST_IMAGES,
        ["36", "android-wear", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=35\n"],
      ]);
      const catalog = await part.listCatalog();
      const pairs = Object.entries(catalog.modelRuntimes).flatMap(([model, levels]) =>
        levels.map((level) => ({ level, model })),
      );
      const left = Object.entries(catalog.modelRuntimes).flatMap(([model, levels]) =>
        catalog.runtimes
          .filter((level) => !levels.includes(level))
          .map((level) => ({ level, model })),
      );
      expect(pairs.length).toBeGreaterThan(0);
      expect(left.length).toBeGreaterThan(0);

      for (const { level, model } of pairs) {
        expect(await resolve(model, level)).toMatchObject({ model, osVersion: level });
      }
      for (const { level, model } of left) {
        expect(await refusal(model, level)).toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
        });
      }
    });

    it("pairs a devices.xml profile avdmanager did not list with every installed phone level", async () => {
      const { part, resolve } = await fitHarness(HOST_IMAGES, {
        devicesXml: customDeviceXml("Legacy Phone", 2048),
      });

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Legacy Phone"]).toEqual(["35", "36"]);
      expect(await resolve("Legacy Phone", "35")).toMatchObject({ osVersion: "35" });
    });

    it("counts android-Baklava with AndroidVersion.ApiLevel=35 as a level Pixel 9 pairs with", async () => {
      const { part, resolve } = await fitHarness([
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=35\n"],
        ["34", "google_apis", "arm64-v8a"],
      ]);

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Pixel 9"]).toEqual(["Baklava"]);
      expect(await resolve("Pixel 9")).toMatchObject({ osVersion: "Baklava" });
    });

    it("ranks a preview image by the API level it records, so a newer numeric level stays the newest", async () => {
      const { part, resolve } = await fitHarness([
        ["35", "google_apis", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", BAKLAVA_SOURCE_PROPERTIES],
      ]);

      const catalog = await part.listCatalog();

      // why: stated first so the assertions below can only fail on the *ranking* — the preview is
      // genuinely a listed candidate, not something the catalog left out.
      expect(catalog.runtimes).toContain("Baklava");
      expect(catalog.modelRuntimes["Pixel 9"]).toContain("Baklava");
      expect(catalog.defaultRuntime).toBe("37.0");
      expect(await resolve("Pixel 9")).toMatchObject({ osVersion: "37.0" });
    });

    it("ranks a preview image above the numeric levels when the level it records is higher", async () => {
      const { part } = await fitHarness([
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=38\n"],
      ]);

      expect((await part.listCatalog()).defaultRuntime).toBe("Baklava");
    });

    it("ranks a preview folder by the highest level any of its images records, so an image recording none does not raise it", async () => {
      const { part } = await fitHarness([
        ["36", "google_apis", "arm64-v8a"],
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", BAKLAVA_SOURCE_PROPERTIES],
        ["Baklava", "google_apis_playstore", "arm64-v8a"],
      ]);

      expect((await part.listCatalog()).defaultRuntime).toBe("37.0");
    });

    it.each([
      ["lower first", "35", "38"],
      ["higher first", "38", "35"],
    ])(
      "ranks a preview folder by the highest level among its images, whichever is read first (%s)",
      async (_order, first, second) => {
        const { part } = await fitHarness([
          ["37.0", "google_apis", "arm64-v8a"],
          ["Baklava", "google_apis", "arm64-v8a", `AndroidVersion.ApiLevel=${first}\n`],
          ["Baklava", "google_apis_playstore", "arm64-v8a", `AndroidVersion.ApiLevel=${second}\n`],
        ]);

        expect((await part.listCatalog()).defaultRuntime).toBe("Baklava");
      },
    );

    it("uses the folder name for --image-tag and the catalog's images[].tag when SystemImage.TagId differs", async () => {
      const { part, refusal, resolve } = await fitHarness([
        ["35", "custom-folder", "arm64-v8a", "SystemImage.TagId=google_apis_playstore\n"],
      ]);

      const catalog = await part.listCatalog();

      expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "35", tag: "custom-folder" }]);
      expect(await resolve("Pixel 5", undefined, "custom-folder")).toMatchObject({
        imageTag: "custom-folder",
      });
      expect(await refusal("Pixel 5", undefined, "google_apis_playstore")).toMatchObject({
        downloadable: false,
        name: "RuntimeMissingError",
      });
    });
  });

  describe("resolveSpec", () => {
    it("gives a request with no version the newest level with a fitting image", async () => {
      const { resolve } = await fitHarness([
        ["34", "android-tv", "arm64-v8a"],
        ["35", "android-tv", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
      ]);

      expect(await resolve("Television (1080p)")).toMatchObject({ osVersion: "35" });
    });

    it("fails a request with no version RUNTIME_MISSING, not downloadable, when no level has a fitting image", async () => {
      const { refusal } = await fitHarness([["36", "google_apis", "arm64-v8a"]]);

      expect(await refusal("Television (1080p)")).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
    });

    it("skips a newest level whose image of the tag misfits and takes the newest level where it fits", async () => {
      const { resolve } = await fitHarness(
        [
          ["34", "google_apis_playstore", "arm64-v8a"],
          ["36", "google_apis_playstore", "arm64-v8a"],
        ],
        {
          profiles: [
            testLibraryProfile({
              apiRange: { max: 35, min: 24 },
              name: "Capped",
              names: ["Capped"],
            }),
          ],
        },
      );

      expect(await resolve("Capped", undefined, "google_apis_playstore")).toMatchObject({
        osVersion: "34",
      });
    });
  });

  describe("refusal messages", () => {
    const phones: readonly FitImage[] = [
      ["35", "google_apis", "arm64-v8a"],
      ["36", "google_apis_playstore", "arm64-v8a"],
    ];

    it("names the API range for an API level below the profile's minimum", async () => {
      const { refusal } = await fitHarness([["34", "google_apis", "arm64-v8a"]]);

      expect((await refusal("Pixel 9", "34")).message).toBe(
        "No installed system image fits Pixel 9 at Android 34: it needs Android 35 or newer",
      );
    });

    it("names the API range for a level above the profile's maximum", async () => {
      const { refusal } = await fitHarness([["35", "google_apis", "arm64-v8a"]], {
        profiles: [
          testLibraryProfile({
            apiRange: { max: 33, min: 24 },
            name: "Old Phone",
            names: ["Old Phone"],
          }),
        ],
      });

      expect((await refusal("Old Phone", "35")).message).toBe(
        "No installed system image fits Old Phone at Android 35: it needs Android 33 or older",
      );
    });

    it.each([
      ["Television (1080p)", "it needs a TV image"],
      ["Wear OS Large Round", "it needs a Wear OS image"],
      ["Automotive (1080p landscape)", "it needs an automotive image"],
      ["Medium Desktop", "it needs a desktop image"],
      ["XR Headset", "it needs an XR image"],
      ["AI Glasses", "it needs an AI glasses image"],
    ])("names the kind for %s with only phone images", async (model, reason) => {
      const { refusal } = await fitHarness(phones);

      expect((await refusal(model, "35")).message).toBe(
        `No installed system image fits ${model} at Android 35: ${reason}`,
      );
    });

    it("names phone or tablet for a profile with no kind whose only image is a TV image", async () => {
      const { refusal } = await fitHarness([["34", "android-tv", "arm64-v8a"]]);

      expect((await refusal("Pixel 5", "34")).message).toBe(
        "No installed system image fits Pixel 5 at Android 34: it needs a phone or tablet image",
      );
    });

    it("names the tag for any other kind", async () => {
      const { refusal } = await fitHarness(phones);

      expect((await refusal("Odd Device", "35")).message).toBe(
        "No installed system image fits Odd Device at Android 35: it needs an image tagged foo-device",
      );
    });

    it.each([
      ["Pixel 6", "36", "google_apis_playstore", "Play Store"],
      ["Pixel 5", "35", "tablet", "tablet"],
    ])(
      "says the model does not take the kind of image it was given (%s)",
      async (model, osVersion, imageTag, noun) => {
        const { refusal } = await fitHarness([[osVersion, imageTag, "arm64-v8a"]]);

        expect((await refusal(model, osVersion)).message).toBe(
          `No installed system image fits ${model} at Android ${osVersion}: ${model} does not take ${noun} images`,
        );
      },
    );

    it("says none of the installed images fit it when no single check rules out every image", async () => {
      const { refusal } = await fitHarness([
        ["35", "google_apis_playstore", "arm64-v8a"],
        ["35", "android-tv", "arm64-v8a"],
      ]);

      expect((await refusal("Pixel 6", "35")).message).toBe(
        "No installed system image fits Pixel 6 at Android 35: none of the installed images fit it",
      );
    });

    it("gives the API range reason for an image that fails both API range and kind", async () => {
      const { refusal } = await fitHarness([["34", "android-tv", "arm64-v8a"]]);

      expect((await refusal("Pixel 9", "34")).message).toBe(
        "No installed system image fits Pixel 9 at Android 34: it needs Android 35 or newer",
      );
    });

    it("drops the level from the message when no version was asked, reading every installed image", async () => {
      const { refusal } = await fitHarness([["36", "google_apis", "arm64-v8a"]]);

      expect((await refusal("Television (1080p)")).message).toBe(
        "No installed system image fits Television (1080p): it needs a TV image",
      );
    });

    it("says an image tag's image does not fit it, and why", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Television (1080p)", undefined, "google_apis")).message).toBe(
        "No installed system image fits Television (1080p): the google_apis image does not fit it: it needs a TV image",
      );
      expect((await refusal("Television (1080p)", "35", "google_apis")).message).toBe(
        "No installed system image fits Television (1080p) at Android 35: the google_apis image does not fit it: it needs a TV image",
      );
    });

    it("says the level is not installed for a level with nothing installed", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Pixel 9", "37")).message).toBe(
        "No installed system image fits Pixel 9 at Android 37: Android 37 is not installed",
      );
    });

    it("says no system image is installed on a host with no image at all", async () => {
      const { refusal } = await fitHarness([]);

      expect((await refusal("Pixel 9")).message).toBe(
        "No installed system image fits Pixel 9: no system image is installed",
      );
    });

    it("keeps today's message for an image tag with no image of that tag installed", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Pixel 5", "35", "default")).message).toBe(
        "No default system image is installed for Android API 35",
      );
    });
  });

  describe("an image tag whose image misfits", () => {
    it("fails RUNTIME_MISSING, not downloadable, and starts no sdkmanager", async () => {
      const { refusal, runner } = await fitHarness(HOST_IMAGES);

      const failure = await refusal("Pixel 6", undefined, "google_apis_playstore");

      expect(failure).toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
      expect(failure.message).toContain("the google_apis_playstore image does not fit it");
      expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
    });
  });

  describe("custom profile fit from devices.xml", () => {
    const wearImage: FitImage = [
      "34",
      "android-wear",
      "arm64-v8a",
      "SystemImage.TagId=android-wear,google_apis_playstore\n",
    ];

    it("a custom profile listed by avdmanager gets the API range of its devices.xml entry: api-level 31- drops levels below 31 from its modelRuntimes", async () => {
      const images: readonly FitImage[] = [
        ["30", "google_apis", "arm64-v8a"],
        ["31", "google_apis", "arm64-v8a"],
        ["30", "android-tv", "arm64-v8a"],
        ["31", "android-tv", "arm64-v8a"],
      ];
      const open = await fitHarness(images, {
        devicesXml: customFitXml({ name: "Open Phone" }),
        listing: userListing(["Open Phone"]),
      });
      expect((await open.part.listCatalog()).modelRuntimes["Open Phone"]).toEqual(["30", "31"]);
      const { part } = await fitHarness(images, {
        devicesXml:
          customFitXml({ apiLevel: "31-", name: "My Phone" }) +
          customFitXml({ apiLevel: "31-", name: "My TV", tagId: "android-tv" }),
        listing: userListing(["My Phone"], ["My TV", "android-tv"]),
      });

      const { modelRuntimes } = await part.listCatalog();

      expect(modelRuntimes["My Phone"]).toEqual(["31"]);
      expect(modelRuntimes["My TV"]).toEqual(["31"]);
    });

    it("a custom profile with playstore-enabled false drops Play Store images", async () => {
      const images: readonly FitImage[] = [
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["35", "google_apis", "arm64-v8a"],
      ];
      const allowed = await fitHarness(images, {
        devicesXml: customFitXml({ name: "My Phone", playStore: "true" }),
        listing: userListing(["My Phone"]),
      });
      expect((await allowed.part.listCatalog()).modelRuntimes["My Phone"]).toEqual(["34", "35"]);
      const { part } = await fitHarness(images, {
        devicesXml: customFitXml({ name: "My Phone", playStore: "false" }),
        listing: userListing(["My Phone"]),
      });

      expect((await part.listCatalog()).modelRuntimes["My Phone"]).toEqual(["35"]);
    });

    it("a custom Wear profile with playstore-enabled false keeps an image tagged android-wear,google_apis_playstore, listed by avdmanager or devices.xml-only", async () => {
      const wear = customFitXml({ name: "My Watch", playStore: "false", tagId: "android-wear" });
      const listed = await fitHarness([wearImage], {
        devicesXml: wear,
        listing: userListing(["My Watch", "android-wear"]),
      });
      const only = await fitHarness([wearImage], { devicesXml: wear, listing: userListing() });

      expect((await listed.part.listCatalog()).modelRuntimes["My Watch"]).toEqual(["34"]);
      expect((await only.part.listCatalog()).modelRuntimes["My Watch"]).toEqual(["34"]);
    });

    it("a custom profile with no type and a 10.1-inch screen that does not fold fits tablet images; a 6-inch one, one with folded dimensions and one with no diagonal do not", async () => {
      const images: readonly FitImage[] = [
        ["35", "google_apis", "arm64-v8a"],
        ["36", "tablet", "arm64-v8a"],
      ];
      const { part } = await fitHarness(images, {
        devicesXml:
          customFitXml({ diagonal: "10.1", name: "Big" }) +
          customFitXml({ diagonal: "6", name: "Small" }) +
          customFitXml({ diagonal: "10.1", folded: true, name: "Folds" }) +
          customFitXml({ name: "NoDiagonal" }),
        listing: userListing(["Big"], ["Small"], ["Folds"], ["NoDiagonal"]),
      });

      const { modelRuntimes } = await part.listCatalog();

      expect(modelRuntimes["Big"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Small"]).toEqual(["35"]);
      expect(modelRuntimes["Folds"]).toEqual(["35"]);
      expect(modelRuntimes["NoDiagonal"]).toEqual(["35"]);
    });

    it("a custom profile with nothing but a name pairs as after #489", async () => {
      const { part } = await fitHarness(HOST_IMAGES, {
        devicesXml: customFitXml({ name: "Old" }),
        listing: userListing(["Old"]),
      });

      expect((await part.listCatalog()).modelRuntimes["Old"]).toEqual(["35", "36"]);
    });

    it("a custom profile's class still comes from avdmanager's Tag line", async () => {
      const { part } = await fitHarness(HOST_IMAGES, {
        devicesXml: customFitXml({ name: "My TV", tagId: "android-wear" }),
        listing: userListing(["My TV", "android-tv"]),
      });

      expect((await part.listCatalog()).modelClasses["My TV"]).toBe("tv");
    });

    it("a devices.xml profile avdmanager does not list fits by its own tag-id, range, Play Store flag and screen, and is classed by its tag-id", async () => {
      const images: readonly FitImage[] = [
        ["30", "android-tv", "arm64-v8a"],
        ["31", "android-tv", "arm64-v8a"],
        ["30", "google_apis", "arm64-v8a"],
        ["31", "google_apis_playstore", "arm64-v8a"],
        ["32", "google_apis", "arm64-v8a"],
        ["33", "tablet", "arm64-v8a"],
      ];
      const { part } = await fitHarness(images, {
        devicesXml:
          customFitXml({ apiLevel: "31-", name: "Only TV", tagId: "android-tv" }) +
          customFitXml({ name: "Only Phone", playStore: "false" }) +
          customFitXml({ diagonal: "10.1", name: "Only Tablet" }),
        listing: userListing(),
      });

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Only TV"]).toEqual(["31"]);
      expect(catalog.modelRuntimes["Only Phone"]).toEqual(["30", "32"]);
      expect(catalog.modelRuntimes["Only Tablet"]).toEqual(["30", "31", "32", "33"]);
      expect(catalog.modelClasses["Only TV"]).toBe("tv");
      expect(catalog.modelClasses["Only Phone"]).toBe("phone");
    });

    it("reads devices.xml from ANDROID_USER_HOME, then ANDROID_PREFS_ROOT, then ANDROID_SDK_HOME, then home", async () => {
      const paths = [
        "/user-home/devices.xml",
        "/prefs/.android/devices.xml",
        "/sdk-home/.android/devices.xml",
        `${home}/.android/devices.xml`,
      ];
      const env = {
        ANDROID_PREFS_ROOT: "/prefs",
        ANDROID_SDK_HOME: "/sdk-home",
        ANDROID_USER_HOME: "/user-home",
      };
      const names = ["From user home", "From prefs root", "From sdk home", "From home"];
      const outcomes: string[][] = [];
      for (let first = 0; first < paths.length; first++) {
        const used: Record<string, string> = {};
        if (first <= 0) used["ANDROID_USER_HOME"] = env.ANDROID_USER_HOME;
        if (first <= 1) used["ANDROID_PREFS_ROOT"] = env.ANDROID_PREFS_ROOT;
        if (first <= 2) used["ANDROID_SDK_HOME"] = env.ANDROID_SDK_HOME;
        const { part, filesystem } = await fitHarness(HOST_IMAGES, {
          extraEnv: used,
          listing: userListing(),
        });
        for (const [index, path] of paths.entries()) {
          await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
          await filesystem.writeFileAtomic(
            path,
            `<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">${customFitXml({ name: names[index] as string })}</d:devices>`,
          );
        }
        outcomes.push(
          (await part.listCatalog()).models.filter((model) => model.startsWith("From ")),
        );
      }

      expect(outcomes).toEqual(names.map((name) => [name]));
    });
  });
});
