import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  FakeTcpProbe,
  MemoryFilesystem,
  type ProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { AdbTools } from "./adb-tools.js";
import { AvdConfig } from "./avd-config.js";
import { Catalog } from "./catalog.js";
import { ConsolePorts, portAllocatorFor } from "./console-ports.js";
import type { DeviceProfileSource } from "./device-profile-source.js";
import { DeviceTable } from "./device-table.js";
import { Emulator } from "./emulator.js";
import { Ownership } from "./ownership.js";
import { LIBRARY_PROFILES, type LibraryDeviceProfile } from "./profiles/index.js";
import { Seeds } from "./seeds.js";
import { SystemImages } from "./system-images.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  androidFilesystem,
  avdDirectory,
  binaries,
  bootingAt,
  bootProbes,
  type BuildProvisioner,
  createdFromPackage,
  customDeviceXml,
  customFitXml,
  EmulatorExitingRunner,
  fitHarness as fitHarnessWith,
  HOST_IMAGES,
  libraryHarness as libraryHarnessWith,
  makingASeedFrom,
  makingTheSeed,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  seedConfig,
  seedEmulatorLine,
  seedStages,
  taggedHarness as taggedHarnessWith,
  testLibraryProfile,
  twoPixelDevices,
  writeSeedFiles,
} from "./testing.js";

const adbServerPort = 5038;

/** why: the part and the catalog that resolves its specs, built the way the driver builds them over one scripted runner. */
function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly bootTimeoutMs?: number;
    readonly clock?: FakeClock;
    readonly database: Awaited<ReturnType<typeof memoryAndroidSourceDatabase>>;
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly ids?: readonly string[];
    readonly seedLaunchInputs?: readonly string[];
  },
) {
  let nextId = 0;
  const clock = options.clock ?? new FakeClock();
  const env = { ANDROID_HOME: sdk, ...options.extraEnv };
  const adbTools = new AdbTools({
    adb: binaries.adb,
    adbServerPort,
    baseEnv: env,
    clock,
    deviceRoot: avdDirectory,
    emulator: binaries.emulator,
    processRunner,
  });
  const idGenerator = { generate: () => options.ids?.[nextId++] ?? `device-${nextId}` };
  const ownership = new Ownership({ adb: binaries.adb, adbTools, filesystem });
  const avdConfig = new AvdConfig({
    adb: binaries.adb,
    adbTools,
    filesystem,
    idGenerator,
    seedLaunchInputs: options.seedLaunchInputs ?? [],
  });
  const emulator = new Emulator({
    adb: binaries.adb,
    adbServerPort,
    adbTools,
    clock,
    deviceRoot: avdDirectory,
    emulator: binaries.emulator,
    emulatorLaunch: undefined,
    filesystem,
    onDiagnostic: undefined,
    ownership,
    processRunner,
    bootTimeoutMs: options.bootTimeoutMs ?? 300_000,
    tcpProbe: new FakeTcpProbe([adbServerPort]),
  });
  const systemImages = new SystemImages({
    acceptAndroidLicenses: false,
    clock,
    deviceRoot: avdDirectory,
    filesystem,
    hostAbi: options.hostAbi ?? "arm64-v8a",
    legacyAvdHome: `${home}/.android/avd`,
    processRunner,
    sdk: {
      adb: binaries.adb,
      emulator: binaries.emulator,
      root: sdk,
      sdkmanager: binaries.sdkmanager,
    },
  });
  const catalog = new Catalog({
    avdmanager: binaries.avdmanager,
    avdmanagerEnv: () => adbTools.env(),
    deviceProfileSources: options.deviceProfileSources,
    env,
    filesystem,
    homeDirectory: home,
    onDiagnostic: undefined,
    processRunner,
    sdkRoot: sdk,
    systemImages,
  });
  const seeds = new Seeds({
    adb: binaries.adb,
    adbTools,
    avdConfig,
    avdmanager: binaries.avdmanager,
    bootTimeoutMs: options.bootTimeoutMs ?? 300_000,
    catalog,
    clock,
    consolePorts: new ConsolePorts({
      adbTools,
      allocator: portAllocatorFor(processRunner, binaries.adb),
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    }),
    database: options.database,
    deviceRoot: avdDirectory,
    deviceTable: new DeviceTable({
      adbTools,
      avdConfig,
      avdmanager: binaries.avdmanager,
      baseEnv: env,
      deviceRoot: avdDirectory,
      filesystem,
      legacyAvdHome: `${home}/.android/avd`,
      ownership,
      register: async () => undefined,
    }),
    emulator,
    filesystem,
    idGenerator,
    ownership,
    processRunner,
    systemImages,
  });
  return { catalog, seeds };
}

const buildPart: BuildProvisioner = async (filesystem, processRunner, options) => {
  const { catalog, seeds } = createPart(filesystem, processRunner, {
    ...options,
    database: await memoryAndroidSourceDatabase(),
  });
  return {
    listCatalog: () => catalog.listCatalog(),
    provision: (spec) => seeds.provision(spec),
    resolveSpec: (request) => catalog.resolveSpec(request),
  };
};
const fitHarness = (
  ...args: Parameters<typeof fitHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => fitHarnessWith(buildPart, ...args);
const libraryHarness = (options?: Parameters<typeof libraryHarnessWith>[1]) =>
  libraryHarnessWith(buildPart, options);
const taggedHarness = (
  ...args: Parameters<typeof taggedHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => taggedHarnessWith(buildPart, ...args);

const sources = `${avdDirectory}/sources`;
const copyHome = `${avdDirectory}/simlock_one`;
const seedHome = `${sources}/seed_two`;

async function seedHarness(
  expectations: readonly ScriptedProcessExpectation[],
  options: {
    readonly bootTimeoutMs?: number;
    readonly clock?: FakeClock;
    readonly config?: string;
    readonly filesystem?: MemoryFilesystem;
    readonly ids?: readonly string[];
  } = {},
) {
  const filesystem = await androidFilesystem({}, options.filesystem);
  await writeSeedFiles(filesystem, seedHome, options.config);
  const database = await memoryAndroidSourceDatabase();
  const runner = new EmulatorExitingRunner([
    processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ...expectations,
  ]);
  const part = createPart(filesystem, runner, {
    ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    database,
    ids: options.ids ?? ["one", "two", "three"],
  });
  const spec = await part.catalog.resolveSpec({
    model: "Pixel 5",
    osVersion: "34",
    platform: "android",
  });
  return { database, filesystem, runner, spec, ...part };
}

/** why: the daemon after a restart: a new part over the same device folders and the same source table. */
function reopened(
  harness: Awaited<ReturnType<typeof seedHarness>>,
  expectations: readonly ScriptedProcessExpectation[],
  options: { readonly clock?: FakeClock; readonly seedLaunchInputs?: readonly string[] } = {},
) {
  const runner = new EmulatorExitingRunner([...expectations]);
  const part = createPart(harness.filesystem, runner, {
    ...options,
    database: harness.database,
    ids: ["four", "five", "six"],
  });
  return { ...part, runner };
}

function libraryPixel9(): LibraryDeviceProfile {
  const profile = LIBRARY_PROFILES.find((candidate) => candidate.id === "pixel_9");
  if (profile === undefined) throw new Error("the library has no profile with id pixel_9");
  return profile;
}

class SizeFailureFilesystem extends MemoryFilesystem {
  override directorySize(): Promise<number> {
    return Promise.reject(new Error("EIO"));
  }
}

class CopyFailureFilesystem extends MemoryFilesystem {
  readonly #message: string;

  constructor(message: string) {
    super();
    this.#message = message;
  }

  override copyTree(): Promise<void> {
    return Promise.reject(new Error(this.#message));
  }
}

class WriteFailureFilesystem extends MemoryFilesystem {
  armed = false;

  constructor(
    private readonly failingPath: string,
    private readonly error: Error,
  ) {
    super();
  }

  override async writeFileAtomic(
    ...args: Parameters<MemoryFilesystem["writeFileAtomic"]>
  ): Promise<void> {
    if (this.armed && args[0] === this.failingPath) {
      throw this.error;
    }
    return super.writeFileAtomic(...args);
  }
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Seeds` directly over a memory filesystem and a scripted runner, with the real parts it takes.
describe("Seeds", () => {
  describe("image tag", () => {
    it("creates a tagged device from the host ABI's image when the tag is installed for two ABIs", async () => {
      // why: On an x86_64 host the foreign arm64-v8a image is listed first, so taking the first image
      // of the tag would pick it.
      const { driver, runner } = await taggedHarness(
        [
          ["34", "google_apis_playstore", "arm64-v8a"],
          ["34", "google_apis_playstore", "x86_64"],
        ],
        "x86_64",
      );

      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;x86_64",
      );
    });

    it("creates a tagged device from a foreign ABI's image when that is the only image of the tag", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "x86_64"],
      ]);

      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;x86_64",
      );
    });

    it("fails provisioning a tagged spec whose image went missing after it resolved, offering no download", async () => {
      const { driver, filesystem, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
      ]);
      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await filesystem.rm(`${sdk}/system-images/android-34/google_apis_playstore`);

      const failure = await driver.provision(spec).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
      expect((failure as Error).message).toContain("google_apis_playstore");
      expect(createdFromPackage(runner)).toBeUndefined();
    });
  });

  it("does not change the config hash when simlock.mark is present in config.ini", async () => {
    const hashWith = async (config: string) => {
      const harness = await seedHarness(makingTheSeed(), { config });
      const device = await harness.seeds.provision(harness.spec);
      return (device.driverData as { configHash: string }).configHash;
    };

    expect(await hashWith("hw.ramSize=2048\nsimlock.mark=some-token\n")).toBe(
      await hashWith("hw.ramSize=2048\n"),
    );
  });

  describe("device-profile sources", () => {
    it("captures differing hardware properties in the config hash, proving they land before it is computed", async () => {
      const hashWith = async (ramMiB: number) => {
        const harness = await libraryHarness({ devicesXml: customDeviceXml("Custom A", ramMiB) });
        const device = await harness.provision("Custom A");
        return (device.driverData as { configHash: string }).configHash;
      };

      expect(await hashWith(2048)).not.toBe(await hashWith(4096));
    });

    it("shadows a devices.xml profile with a built-in one of the same name and never applies properties", async () => {
      // why: same name as the built-in fixture's "Pixel 5" -- the built-in source is registered
      // first, so it must win and the devices.xml properties must never be touched.
      const harness = await libraryHarness({ devicesXml: customDeviceXml("Pixel 5", 4096) });
      const seeded = await harness.filesystem.readFile(harness.configPath);

      await harness.provision("Pixel 5");

      await expect(harness.filesystem.readFile(harness.configPath)).resolves.toBe(seeded);
    });

    it("rejects a hardware-property value with an embedded line break, defense in depth beyond the devices.xml parser", async () => {
      // why: `UserDeviceProfileSource`/`parseDevicesXml` already reject this at the devices.xml parse
      // boundary (see device-profile-source.test.ts), but `DeviceProfileSource` is a documented
      // extension point (see the interface's own doc comment) -- a future or third-party source
      // could hand the driver a multiline value directly, bypassing that parser entirely. This
      // exercises `#mergeConfigIniLines`'s own independent guard by going around the parser with
      // a custom source, standing in for `<d:manufacturer>Google\ndisk.dataPartition.path=/evil
      // </d:manufacturer>`.
      const maliciousSource = {
        async profiles() {
          return [
            {
              hardwareProperties: {
                "hw.device.manufacturer": "Acme\ndisk.dataPartition.path=/evil",
                "hw.device.name": "Evil Phone",
              },
              kind: "properties" as const,
              name: "Evil Phone",
              names: ["Evil Phone"],
            },
          ];
        },
      };
      const harness = await libraryHarness({ sources: [maliciousSource] });

      await expect(harness.provision("Evil Phone")).rejects.toThrow(/line break/);

      // why: a failed seed make removes its folder, so none of the rejected value stays on disk.
      await expect(harness.filesystem.exists(harness.configPath)).resolves.toBe(false);
    });

    it("writes the same config.ini keys for a rich devices.xml profile as for a plain one", async () => {
      const keysOf = async (xml: string) => {
        const harness = await libraryHarness({
          devicesXml: xml,
          extraImages: [["35", "android-tv", "arm64-v8a"]],
        });
        await harness.provision("Keyed");
        return [...(await harness.config()).keys()].sort();
      };
      const plain = customDeviceXml("Keyed", 4096);
      const rich = customFitXml({
        apiLevel: "31-",
        diagonal: "10.1",
        name: "Keyed",
        playStore: "false",
        tagId: "android-tv",
      }).replace("</d:hardware>", '<d:ram unit="MiB">4096</d:ram></d:hardware>');

      const plainKeys = await keysOf(plain);
      expect(plainKeys).toEqual([
        "PlayStore.enabled",
        "abi.type",
        "avd.ini.encoding",
        "disk.dataPartition.size",
        "hw.cpu.arch",
        "hw.device.name",
        "hw.lcd.density",
        "hw.ramSize",
        "hw.seedOnly",
        "image.sysdir.1",
        "showDeviceFrame",
        "skin.name",
        "skin.path",
        "tag.id",
        "target",
        "vm.heapSize",
      ]);
      expect(await keysOf(rich)).toEqual(plainKeys);
    });
  });

  describe("library device profiles", () => {
    it("provisions a library device with every `hardware` value of the profile in `config.ini`", async () => {
      const harness = await libraryHarness({ listing: pixelDevices });

      await harness.provision("Pixel 9");

      const config = await harness.config();
      const hardware = Object.entries(libraryPixel9().hardware);
      expect(hardware.length).toBeGreaterThan(100);
      expect(hardware.filter(([key, value]) => config.get(key) !== value)).toEqual([]);
    });

    it("provisions identical `hw.*` and `vm.heapSize` lines whether `avdmanager list device` lists `pixel_9` or not", async () => {
      const without = await libraryHarness({ listing: pixelDevices });
      const withListed = await libraryHarness({
        listing: twoPixelDevices,
        seed: seedConfig(["hw.gpu.mode=host", "hw.lcd.density=480", "hw.ramSize=8G"]),
      });

      await without.provision("Pixel 9");
      await withListed.provision("Pixel 9");

      const hardwareLines = async (harness: typeof without) =>
        (await harness.lines()).filter((line) => /^(hw\.|vm\.heapSize=)/.test(line)).sort();
      const expected = await hardwareLines(without);
      expect(expected.length).toBeGreaterThan(100);
      expect(await hardwareLines(withListed)).toEqual(expected);
    });

    it("removes every `hw.*` (except `hw.cpu.arch`), `vm.heapSize` and `skin.*` line the seed wrote that the profile does not set", async () => {
      const harness = await libraryHarness({
        profiles: [testLibraryProfile({ hardware: { "hw.lcd.height": "100" } })],
        seed: seedConfig(["hw.seedOnly=yes", "skin.dynamic=yes"]),
      });

      await harness.provision("Test Phone");

      const lines = await harness.lines();
      expect(lines.filter((line) => line.startsWith("skin."))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("vm.heapSize"))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("hw.")).sort()).toEqual([
        "hw.cpu.arch=arm64",
        "hw.lcd.height=100",
      ]);
    });

    it("keeps `image.sysdir.1`, `tag.id`, `abi.type`, `target`, `hw.cpu.arch`, `disk.dataPartition.size` and `showDeviceFrame` as `avdmanager` wrote them", async () => {
      const harness = await libraryHarness({ listing: pixelDevices });

      await harness.provision("Pixel 9");

      const config = await harness.config();
      expect(
        [
          "image.sysdir.1",
          "tag.id",
          "abi.type",
          "target",
          "hw.cpu.arch",
          "disk.dataPartition.size",
          "showDeviceFrame",
        ].map((key) => `${key}=${config.get(key)}`),
      ).toEqual([
        "image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/",
        "tag.id=google_apis",
        "abi.type=arm64-v8a",
        "target=android-35",
        "hw.cpu.arch=arm64",
        "disk.dataPartition.size=6G",
        "showDeviceFrame=yes",
      ]);
    });

    it("sets `PlayStore.enabled=yes` on a Play Store image when the profile allows Play Store, and `no` on a `google_apis` image", async () => {
      const playStore = { imageTag: "google_apis_playstore" };
      const allowed = await libraryHarness({ ...playStore, listing: pixelDevices });
      await allowed.provision("Pixel 9");
      expect((await allowed.config()).get("PlayStore.enabled")).toBe("yes");

      const googleApis = await libraryHarness({
        listing: pixelDevices,
        seed: seedConfig(["PlayStore.enabled=yes"]),
      });
      await googleApis.provision("Pixel 9");
      expect((await googleApis.config()).get("PlayStore.enabled")).toBe("no");
    });

    it("reads an image's tags from `SystemImage.TagId`, and from the folder name when it has none", async () => {
      const playStoreOf = async (imageTag: string, imageProperties: string) => {
        const harness = await libraryHarness({ imageProperties, imageTag, listing: pixelDevices });
        await harness.provision("Pixel 9");
        return (await harness.config()).get("PlayStore.enabled");
      };

      expect(await playStoreOf("custom-folder", "SystemImage.TagId=google_apis_playstore\n")).toBe(
        "yes",
      );
      expect(await playStoreOf("google_apis_playstore", "")).toBe("yes");
      expect(await playStoreOf("google_apis_playstore", "Pkg.Revision=1\n")).toBe("yes");
      expect(await playStoreOf("google_apis_playstore", "SystemImage.TagId=google_apis\n")).toBe(
        "no",
      );
    });

    it("writes the profile's boot properties to `boot.prop`, and removes a seed's `boot.prop` when the profile has none", async () => {
      const withProperties = await libraryHarness({
        profiles: [
          testLibraryProfile({ bootProperties: { "persist.x": "y", "ro.simlock.test": "1" } }),
        ],
        seedBootProp: "ro.seed=1\n",
      });
      await withProperties.provision("Test Phone");
      const written = await withProperties.filesystem.readFile(withProperties.bootPropPath);
      expect(
        written
          .split("\n")
          .filter((line) => line !== "")
          .sort(),
      ).toEqual(["persist.x=y", "ro.simlock.test=1"]);

      const without = await libraryHarness({ listing: pixelDevices, seedBootProp: "ro.seed=1\n" });
      await expect(without.filesystem.exists(without.bootPropPath)).resolves.toBe(true);
      await without.provision("Pixel 9");
      await expect(without.filesystem.exists(without.bootPropPath)).resolves.toBe(false);
    });

    it.each([
      ["a hardware value", "\r"],
      ["a hardware value", "\n"],
      ["a hardware value", "\u0000"],
      ["a hardware key", "\r"],
      ["a hardware key", "\n"],
      ["a hardware key", "\u0000"],
      ["a boot property value", "\r"],
      ["a boot property value", "\n"],
      ["a boot property value", "\u0000"],
    ] as const)(
      "refuses %s with %j before `avdmanager create avd` runs",
      async (where, character) => {
        const profileWith = (inserted: string) =>
          testLibraryProfile(
            where === "a hardware value"
              ? { hardware: { "hw.ramSize": `2${inserted}G` } }
              : where === "a hardware key"
                ? { hardware: { [`hw.bad${inserted}key`]: "1" } }
                : { bootProperties: { "ro.x": `a${inserted}b` } },
          );
        const accepted = await libraryHarness({ profiles: [profileWith("-")] });
        await accepted.provision("Test Phone");
        expect(accepted.createCalls()).toHaveLength(1);

        const refused = await libraryHarness({ profiles: [profileWith(character)] });

        await expect(refused.provision("Test Phone")).rejects.toThrow();
        expect(refused.createCalls()).toEqual([]);
      },
    );

    it("refuses NUL in a `devices.xml` value, through the one shared check", async () => {
      const profileNamed = (name: string): DeviceProfileSource => ({
        async profiles() {
          return [
            {
              hardwareProperties: { "hw.device.name": name },
              kind: "properties" as const,
              name: "Custom A",
              names: ["Custom A"],
            },
          ];
        },
      });
      const accepted = await libraryHarness({ sources: [profileNamed("Custom A")] });
      await accepted.provision("Custom A");
      expect((await accepted.config()).get("hw.device.name")).toBe("Custom A");

      const refused = await libraryHarness({ sources: [profileNamed("Custom\u0000A")] });

      await expect(refused.provision("Custom A")).rejects.toThrow(/Refusing to merge/);
    });

    it("rethrows and runs no `avdmanager delete` when a write after `avdmanager create avd` fails", async () => {
      const filesystem = new WriteFailureFilesystem(
        `${avdDirectory}/sources/seed_two/simlock.avd/config.ini`,
        new Error("disk full"),
      );
      const harness = await libraryHarness({ filesystem, listing: pixelDevices });
      filesystem.armed = true;

      await expect(harness.provision("Pixel 9")).rejects.toThrow("disk full");

      expect(harness.createCalls()).toHaveLength(1);
      expect(harness.runner.calls.some((call) => call.args.includes("delete"))).toBe(false);
    });

    it("seeds `avdmanager create avd` with the first profile `avdmanager list device` prints, also when it lists `pixel_9`", async () => {
      const listsPixel9 = await libraryHarness({ listing: twoPixelDevices });
      await listsPixel9.provision("Pixel 9");

      const lacksPixel9 = await libraryHarness({ listing: pixelDevices });
      await lacksPixel9.provision("Pixel 9");

      expect(listsPixel9.seedDeviceId()).toBe("pixel_5");
      expect(lacksPixel9.seedDeviceId()).toBe("pixel_5");
    });
  });

  describe("image fit", () => {
    it("creates a phone from the Play Store image at the newest level, and the TV from the android-tv image", async () => {
      const phone = await fitHarness(HOST_IMAGES);
      await phone.driver.provision(await phone.resolve("Pixel 5"));
      const tv = await fitHarness(HOST_IMAGES);
      await tv.driver.provision(await tv.resolve("Television (720p)"));

      expect(phone.createdPackage()).toBe(
        "system-images;android-36;google_apis_playstore;arm64-v8a",
      );
      expect(tv.createdPackage()).toBe("system-images;android-34;android-tv;arm64-v8a");
    });

    it("creates the device from a fitting image, never a misfit one that sorts first", async () => {
      const { createdPackage, driver, resolve } = await fitHarness(
        [
          ["34", "google_apis", "arm64-v8a"],
          ["34", "google-tv", "arm64-v8a"],
          ["34", "android-tv", "x86_64"],
        ],
        { hostAbi: "arm64-v8a" },
      );

      await driver.provision(await resolve("Television (720p)"));

      expect(createdPackage()).toBe("system-images;android-34;google-tv;arm64-v8a");
    });

    it.each([
      [
        "host-native google_apis",
        [
          ["35", "default", "arm64-v8a"],
          ["35", "google_apis", "x86_64"],
          ["35", "google_apis", "arm64-v8a"],
        ] as const,
        "system-images;android-35;google_apis;arm64-v8a",
      ],
      [
        "host-native",
        [
          ["35", "google_apis", "x86_64"],
          ["35", "default", "arm64-v8a"],
        ] as const,
        "system-images;android-35;default;arm64-v8a",
      ],
      [
        "google_apis",
        [
          ["35", "default", "x86_64"],
          ["35", "google_apis", "x86_64"],
        ] as const,
        "system-images;android-35;google_apis;x86_64",
      ],
      ["any", [["35", "default", "x86_64"]] as const, "system-images;android-35;default;x86_64"],
    ])("follows today's order among fitting images: %s first", async (_name, images, expected) => {
      const { createdPackage, driver, resolve } = await fitHarness(images);

      await driver.provision(await resolve("Pixel 5", "35"));

      expect(createdPackage()).toBe(expected);
    });

    it("throws RUNTIME_MISSING when no fitting image is left, and creates nothing from a misfit one", async () => {
      const { driver, filesystem, resolve, runner } = await fitHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "android-tv", "arm64-v8a"],
      ]);
      const spec = await resolve("Television (720p)");
      await filesystem.rm(`${sdk}/system-images/android-34/android-tv`);

      await expect(driver.provision(spec)).rejects.toMatchObject({
        downloadable: false,
        name: "RuntimeMissingError",
      });
      expect(runner.calls.some((call) => call.args[0] === "create")).toBe(false);
    });
  });

  describe("seeds and copies", () => {
    it("makes one seed when two plain leases of one kind are provisioned at once", async () => {
      const madeHome = `${sources}/seed_three`;
      const harness = await seedHarness([
        ...makingTheSeed(madeHome),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await writeSeedFiles(harness.filesystem, madeHome);

      const [first, second] = await Promise.all([
        harness.seeds.provision(harness.spec),
        harness.seeds.provision(harness.spec),
      ]);

      expect(harness.runner.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
      expect([first.deviceId, second.deviceId]).toEqual(["simlock_one", "simlock_two"]);
      await expect(
        harness.filesystem.exists(`${avdDirectory}/simlock_two/simlock.avd`),
      ).resolves.toBe(true);
      const listed = await harness.seeds.listSources();
      expect(listed.filter((source) => source.orphan !== true)).toHaveLength(1);
    });

    it("tells why a seed is stale, cut to 300 characters, and clears the reason when the image and emulator match again", async () => {
      const imagePath = `${sdk}/system-images/android-34/google_apis/arm64-v8a`;
      const packageName = "system-images;android-34;google_apis;arm64-v8a";
      const revision = (number: string) => `Pkg.Revision=${number}\n`;
      const original = "Android emulator version 36.1.9";
      const cases = [
        {
          change: async (filesystem: MemoryFilesystem) =>
            filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("2")),
          emulatorVersion: original,
          mend: async (filesystem: MemoryFilesystem) =>
            filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("1")),
          reason: `system image ${packageName} changed from revision 1 to 2`,
        },
        {
          change: async (filesystem: MemoryFilesystem) => filesystem.rm(imagePath),
          emulatorVersion: original,
          mend: async (filesystem: MemoryFilesystem) => {
            await filesystem.mkdirp(imagePath);
            await filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("1"));
          },
          reason: `system image ${packageName} is not installed`,
        },
        {
          emulatorVersion: "Android emulator version 36.2.0",
          reason: `emulator changed from ${original} to Android emulator version 36.2.0`,
        },
        {
          emulatorVersion: "v".repeat(400),
          reason: `emulator changed from ${original} to ${"v".repeat(400)}`.slice(0, 300),
        },
        {
          emulatorVersion: original,
          reason: "android.emulator launch settings changed",
          seedLaunchInputs: ["headless=true", "gpu=auto"],
        },
      ] as const;

      for (const stale of cases) {
        const harness = await seedHarness(makingTheSeed());
        await harness.filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("1"));
        await harness.seeds.provision(harness.spec);
        if ("change" in stale) await stale.change(harness.filesystem);

        const changed = await reopened(
          harness,
          [processResult(binaries.emulator, ["-version"], stale.emulatorVersion)],
          "seedLaunchInputs" in stale ? { seedLaunchInputs: stale.seedLaunchInputs } : {},
        );
        await expect(changed.seeds.listSources()).resolves.toMatchObject([
          { id: "seed_two", staleReason: stale.reason },
        ]);

        if ("mend" in stale) await stale.mend(harness.filesystem);
        const mended = await reopened(harness, [
          processResult(binaries.emulator, ["-version"], original),
        ]);
        const [source] = await mended.seeds.listSources();
        expect(source).toMatchObject({ id: "seed_two" });
        expect(source).not.toHaveProperty("staleReason");
      }
    });

    it("destroys a stale seed and makes it again at the next provision", async () => {
      const harness = await seedHarness(makingTheSeed());
      await harness.seeds.provision(harness.spec);
      const newHome = `${sources}/seed_five`;
      await writeSeedFiles(harness.filesystem, newHome);
      const newer = "Android emulator version 36.2.0";
      const later = await reopened(harness, [
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.emulator, ["-version"], newer),
        ...makingTheSeed(newHome, newer),
        processResult(binaries.emulator, ["-version"], newer),
      ]);

      await later.seeds.provision(harness.spec);

      expect(await harness.filesystem.exists(seedHome)).toBe(false);
      expect(later.runner.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
      await expect(later.seeds.listSources()).resolves.toMatchObject([{ id: "seed_five" }]);
    });

    it("removes a seed's folder and row and throws when making it fails at any step", async () => {
      const stage = seedStages();
      const serial = "emulator-5586";
      const neverReady = [
        stage.devices,
        bootingAt(seedHome, ["-no-snapshot-load"], true)[0],
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          "0\n",
        ),
      ] as ScriptedProcessExpectation[];
      const stuckOff = [
        stage.devices,
        ...bootingAt(seedHome, ["-no-snapshot-load"], true),
        stage.sync,
        stage.powerOff,
        stage.probe,
        stage.kill,
      ];
      const cases = [
        {
          expectations: [
            stage.version,
            { ...stage.create, result: { code: 1, stderr: "no such package", stdout: "" } },
          ],
          message: "no such package",
        },
        {
          advance: 300_000,
          expectations: [stage.version, stage.create, ...neverReady],
          message: "Timed out waiting for device to boot",
        },
        {
          advance: 60_000,
          expectations: [stage.version, stage.create, ...stuckOff],
          killsEmulator: true,
          message: "Android seed seed_two did not power off within 60000ms",
        },
        {
          expectations: [
            stage.version,
            stage.create,
            stage.devices,
            ...stage.firstBoot,
            stage.sync,
            stage.powerOff,
            ...bootingAt(seedHome, ["-no-snapshot-load"], true),
            { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
          ],
          message: "Android seed seed_two: boot snapshot simlock_boot was not saved",
        },
        {
          expectations: [
            stage.version,
            stage.create,
            stage.devices,
            ...stage.firstBoot,
            stage.sync,
            stage.powerOff,
            ...bootingAt(seedHome, ["-no-snapshot-load"], true),
            stage.save,
            processResult(binaries.adb, ["-s", serial, "emu", "avd", "snapshot", "list"], "\n"),
            stage.probe,
            stage.kill,
          ],
          message: "Android seed seed_two: boot snapshot simlock_boot was not saved",
        },
      ] as const;

      for (const failing of cases) {
        const clock = new FakeClock();
        const harness = await seedHarness(failing.expectations, { clock });
        // why: the stuck seed's emulator ignores `reboot -p`; only the 60 s deadline ends the wait.
        harness.runner.ignoresEmuKill = "killsEmulator" in failing;
        const provisioning = harness.seeds.provision(harness.spec);
        const outcome = expect(provisioning).rejects.toThrow(failing.message);
        if ("advance" in failing) {
          await vi.waitFor(() =>
            expect(
              harness.runner.calls.some(
                (call) => call.args.includes("sys.boot_completed") || call.args.includes("reboot"),
              ),
            ).toBe(true),
          );
          clock.advance(failing.advance);
        }
        await outcome;

        if ("killsEmulator" in failing) {
          expect(
            harness.runner.calls.some((call) => call.args.includes("kill")),
            "the seed's emulator was asked to quit by its path",
          ).toBe(true);
        }
        const emulators = harness.runner.calls.flatMap((call, index) =>
          call.args.includes("-avd") ? [index] : [],
        );
        for (const emulator of emulators) {
          let exited = false;
          void harness.runner.handles[emulator]?.wait().then(() => {
            exited = true;
          });
          await vi.waitFor(() => expect(exited, "the seed's emulator was killed").toBe(true));
        }
        expect(await harness.filesystem.exists(seedHome)).toBe(false);
        await expect(harness.seeds.listSources()).resolves.toEqual([]);
        expect(harness.database.prepare("SELECT 1 FROM android_source_data").all()).toEqual([]);
      }
    });

    it("removes the device's folder and throws when copying the seed fails", async () => {
      const harness = await seedHarness(makingTheSeed(), {
        filesystem: new CopyFailureFilesystem("cp: no space left on device"),
      });

      await expect(harness.seeds.provision(harness.spec)).rejects.toThrow(
        "copying Android seed seed_two to simlock_one failed: cp: no space left on device",
      );

      expect(await harness.filesystem.exists(copyHome)).toBe(false);
      expect(await harness.filesystem.exists(seedHome)).toBe(true);
    });

    it("provisions a kind with a ready seed while another kind's seed is being made, and leaves that kind's making row and folder alone", async () => {
      const makingHome = `${sources}/seed_device-4`;
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        // why: the other kind's make never gets past its first boot: its emulator never says it booted.
        ...makingASeedFrom(makingHome).slice(0, 3),
        {
          hangs: true,
          match: {
            args: ["-avd", "simlock", ...seedEmulatorLine, "-no-snapshot-load"],
            command: binaries.emulator,
          },
        },
        {
          hangs: true,
          match: {
            args: ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
            command: binaries.adb,
          },
        },
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await harness.seeds.provision(harness.spec);
      await harness.filesystem.mkdirp(
        `${sdk}/system-images/android-34/google_apis_playstore/arm64-v8a`,
      );
      await writeSeedFiles(harness.filesystem, makingHome);
      const otherKind = await harness.catalog.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      void harness.seeds.provision(otherKind).catch(() => undefined);
      await vi.waitFor(() => expect(bootProbes(harness.runner)).toBeGreaterThan(2));

      let settled = false;
      const provisioning = harness.seeds.provision(harness.spec).finally(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(settled, "the kind with a ready seed waited for the other kind's make").toBe(true),
      );
      const second = await provisioning;

      expect(second.driverData).toMatchObject({ avdHome: expect.stringContaining("/simlock_") });
      expect(
        harness.database.prepare("SELECT state FROM android_source_data ORDER BY state").all(),
      ).toEqual([{ state: "making" }, { state: "ready" }]);
      expect(await harness.filesystem.exists(makingHome)).toBe(true);

      // why: after a restart that row is another process's leftover, which only its own kind's make or a listing sweeps.
      const restarted = await reopened(harness, [
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await restarted.seeds.provision(
        await restarted.catalog.resolveSpec({
          model: "Pixel 5",
          osVersion: "34",
          platform: "android",
        }),
      );
      expect(
        harness.database.prepare("SELECT state FROM android_source_data ORDER BY state").all(),
      ).toEqual([{ state: "making" }, { state: "ready" }]);
      expect(await harness.filesystem.exists(makingHome)).toBe(true);
    });

    it("lists each ready seed with its size, reports a sources folder no row names as an orphan, and destroys a source by id after stopping its emulator by path", async () => {
      const serial = "emulator-5586";
      const orphanHome = `${sources}/seed_orphan`;
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        processResult(binaries.adb, ["devices"], `List of devices attached\n${serial}\tdevice\n`),
        seedStages().probe,
        seedStages().kill,
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      await harness.seeds.provision(harness.spec);
      await writeSeedFiles(harness.filesystem, orphanHome);

      await expect(harness.seeds.listSources()).resolves.toEqual([
        {
          id: "seed_two",
          imageTag: "google_apis",
          kind: "seed",
          model: "Pixel 5",
          osVersion: "34",
          sizeBytes: 16,
        },
        { id: "seed_orphan", kind: "seed", model: "unknown", orphan: true, osVersion: "unknown" },
      ]);
      expect(await harness.filesystem.exists(orphanHome)).toBe(true);

      const callsBefore = harness.runner.calls.length;
      await harness.seeds.destroySource("seed_orphan");
      await harness.seeds.destroySource("seed_two");

      expect(await harness.filesystem.exists(`${sources}/seed_two`)).toBe(false);
      expect(await harness.filesystem.exists(orphanHome)).toBe(false);
      expect(
        harness.runner.calls
          .slice(callsBefore)
          .filter((call) => call.args.includes("kill"))
          .map((call) => call.args),
        "the running emulator of the source is found by its path and stopped before its folder goes",
      ).toEqual([["-s", serial, "emu", "kill"]]);
      await expect(harness.seeds.destroySource("seed_two")).rejects.toThrow(
        "Android keeps no source seed_two",
      );
    });

    it("lists no size for a seed whose size cannot be counted", async () => {
      const filesystem = new SizeFailureFilesystem();
      const harness = await seedHarness(
        [
          ...makingTheSeed(),
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ],
        { filesystem },
      );
      await harness.seeds.provision(harness.spec);

      const [seed] = await harness.seeds.listSources();

      expect(seed).toMatchObject({ id: "seed_two" });
      expect(seed).not.toHaveProperty("sizeBytes");
    });

    it("sweeps a making row an earlier process left, stopping its emulator by path, and one this process has been making past the larger of 900 s and twice android.bootTimeoutMs plus 600 s, and leaves any other this process is making", async () => {
      const serial = "emulator-5586";
      const clock = new FakeClock();
      const stage = seedStages();
      const harness = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          stage.firstBoot[0] as ScriptedProcessExpectation,
          processResult(
            binaries.adb,
            ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            "0\n",
          ),
        ],
        { clock },
      );
      const making = harness.seeds.provision(harness.spec);
      const failed = expect(making).rejects.toThrow("Timed out waiting for device to boot");
      await vi.waitFor(() =>
        expect(harness.runner.calls.some((call) => call.args.includes("sys.boot_completed"))).toBe(
          true,
        ),
      );

      await expect(harness.seeds.listSources()).resolves.toEqual([]);
      expect(await harness.filesystem.exists(seedHome)).toBe(true);

      const restarted = await reopened(harness, [
        processResult(binaries.adb, ["devices"], `List of devices attached\n${serial}\tdevice\n`),
        stage.probe,
        stage.kill,
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      await expect(restarted.seeds.listSources()).resolves.toEqual([]);
      expect(await harness.filesystem.exists(seedHome)).toBe(false);
      clock.advance(300_000);
      await failed;

      const slowClock = new FakeClock();
      const slow = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          stage.firstBoot[0] as ScriptedProcessExpectation,
          processResult(
            binaries.adb,
            ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            "0\n",
          ),
          processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ],
        { bootTimeoutMs: 600_000, clock: slowClock },
      );
      const slowMaking = slow.seeds.provision(slow.spec);
      const slowFailed = expect(slowMaking).rejects.toThrow();
      await vi.waitFor(() =>
        expect(slow.runner.calls.some((call) => call.args.includes("sys.boot_completed"))).toBe(
          true,
        ),
      );
      const ageTo = (ageMs: number) =>
        slow.database
          .prepare("UPDATE android_source_data SET created_at = ?")
          .run(slowClock.now() - ageMs);

      ageTo(1_000_000);
      await slow.seeds.listSources();
      expect(await slow.filesystem.exists(seedHome)).toBe(true);

      ageTo(1_800_000);
      await slow.seeds.listSources();
      expect(await slow.filesystem.exists(seedHome)).toBe(true);

      ageTo(1_800_001);
      await slow.seeds.listSources();
      expect(await slow.filesystem.exists(seedHome)).toBe(false);
      slowClock.advance(600_000);
      await slowFailed;
    });
  });
});
