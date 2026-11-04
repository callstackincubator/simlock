import {
  DriverCrashError,
  type DeviceClass,
  type DriverCatalogEntry,
  type DriverCatalogImage,
  type ExactDeviceRequest,
  type VirtualSpec,
} from "../../core/index.js";
import { type Filesystem, type ProcessRunner } from "../../ports/index.js";
import type { SystemImage } from "./data.js";
import {
  AvdmanagerDeviceList,
  BuiltinDeviceProfileSource,
  DeviceProfileRegistry,
  hiddenUserProfiles,
  UserDeviceProfileSource,
  type DeviceProfile,
  type DeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
  type HiddenUserProfile,
} from "./device-profile-source.js";
import { fits } from "./image-fit.js";
import { LibraryDeviceProfileSource } from "./profiles/index.js";
import {
  AndroidImageTagMissingError,
  compareApiLevels,
  installedApiLevels,
  type SystemImages,
} from "./system-images.js";

/**
 * why: ADR 0015 §4: the models Simlock tries for each class on Android when the operator names none
 * first, newest first. Medium Tablet is Android's only `tablet`; Android has no `vision` list.
 */
export const ANDROID_DEFAULT_MODELS: Readonly<Partial<Record<DeviceClass, readonly string[]>>> = {
  auto: ["Automotive (1080p landscape)", "Automotive (1024p landscape)"],
  desktop: ["Medium Desktop", "Large Desktop"],
  phone: ["Pixel 9", "Pixel 8", "Pixel 7", "Pixel 6", "Medium Phone"],
  tablet: ["Medium Tablet"],
  tv: ["Television (1080p)", "Television (4K)"],
  watch: ["Wear OS Large Round", "Wear OS Small Round"],
};

/** why: the fields of the driver's options that say where `devices.xml` is and how to read it. */
export interface ProfileSourceInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
}

export interface CatalogOptions extends ProfileSourceInputs {
  readonly avdmanager: string;
  /** why: the environment every scoped call carries; an unscoped `avdmanager` would read the user's `~/.android`. */
  readonly avdmanagerEnv: () => NodeJS.ProcessEnv;
  readonly deviceProfileSources?: readonly DeviceProfileSource[] | undefined;
  readonly onDiagnostic: ((diagnostic: DeviceProfileSourceDiagnostic) => void) | undefined;
  readonly processRunner: ProcessRunner;
  readonly sdkRoot: string;
  readonly systemImages: Pick<SystemImages, "installedImages" | "noFittingImage">;
}

/** why: the part of AndroidDriver (ADR 0063) that owns the profile registry, the resolved-profile cache `resolveSpec` writes and the kept `avdmanager list device` answer. */
export class Catalog {
  readonly defaultModels = ANDROID_DEFAULT_MODELS;
  readonly #avdmanager: string;
  readonly #avdmanagerDevices: AvdmanagerDeviceList;
  readonly #deviceProfiles: DeviceProfileRegistry;
  readonly #profileSources: ReturnType<typeof defaultDeviceProfileSources> | undefined;
  readonly #resolvedProfiles = new Map<string, DeviceProfile>();
  readonly #systemImages: CatalogOptions["systemImages"];

  constructor(options: CatalogOptions) {
    this.#avdmanager = options.avdmanager;
    this.#systemImages = options.systemImages;
    this.#avdmanagerDevices = new AvdmanagerDeviceList({
      avdmanager: options.avdmanager,
      devicesXmlPath: userDevicesXmlPath(options),
      env: options.avdmanagerEnv,
      filesystem: options.filesystem,
      processRunner: options.processRunner,
      sdkRoot: options.sdkRoot,
    });
    const defaults =
      options.deviceProfileSources === undefined
        ? defaultDeviceProfileSources(options, this.#avdmanagerDevices, options.onDiagnostic)
        : undefined;
    this.#profileSources = defaults;
    this.#deviceProfiles = new DeviceProfileRegistry(
      options.deviceProfileSources ??
        (defaults === undefined ? [] : [defaults.library, defaults.builtin, defaults.user]),
    );
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    const profile = await this.#deviceProfiles.resolve(request.model);
    const images = await this.#systemImages.installedImages();
    if (request.imageTag !== undefined) {
      const apiLevel = this.#taggedApiLevel(profile, images, request.imageTag, request.osVersion);
      this.#resolvedProfiles.set(profile.name.toLocaleLowerCase(), profile);
      return {
        imageTag: request.imageTag,
        model: profile.name,
        osVersion: apiLevel,
        physical: false,
        platform: "android",
      };
    }

    const levels = fittingApiLevels(profile, images);
    const apiLevel = request.osVersion ?? levels.at(-1);
    if (apiLevel === undefined || !levels.includes(apiLevel)) {
      throw this.#systemImages.noFittingImage(profile, images, request.osVersion);
    }

    this.#resolvedProfiles.set(profile.name.toLocaleLowerCase(), profile);
    return { model: profile.name, osVersion: apiLevel, physical: false, platform: "android" };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const [{ catalog, modelProfiles }, images] = await Promise.all([
      this.#deviceProfiles.catalogWithProfiles(),
      this.#systemImages.installedImages(),
    ]);
    const { customModels, modelAliases, modelClasses, models } = catalog;
    const runtimes = installedApiLevels(images);
    return {
      ...(customModels.length === 0 ? {} : { customModels: [...customModels] }),
      defaultRuntime: runtimes.at(-1),
      images: images
        .map((image) => ({ abi: image.abi, runtime: image.apiLevel, tag: image.tag }))
        .sort(compareCatalogImages),
      modelAliases,
      modelClasses,
      modelRuntimes: Object.fromEntries(
        models.map((model) => {
          const profile = modelProfiles.get(model);
          return [model, profile === undefined ? [] : fittingApiLevels(profile, images)];
        }),
      ),
      models: [...models],
      runtimes,
    };
  }

  /** why: the profile `resolveSpec` chose for this model name, else the one the registry resolves now. */
  async profileFor(model: string): Promise<DeviceProfile> {
    return (
      this.#resolvedProfiles.get(model.toLocaleLowerCase()) ?? this.#deviceProfiles.resolve(model)
    );
  }

  async defaultAvdmanagerDeviceId(): Promise<string> {
    const [first] = await this.#avdmanagerDevices.read();
    if (first === undefined) {
      throw new DriverCrashError(
        `${this.#avdmanager} list device reported no built-in device profiles`,
      );
    }
    return first.id;
  }

  /** why: only the default sources can shadow one another; a caller's own sources have no library or user half. */
  async hiddenProfiles(): Promise<readonly HiddenUserProfile[]> {
    if (this.#profileSources === undefined) return [];
    return hiddenUserProfiles(this.#profileSources.library, this.#profileSources.user);
  }

  #taggedApiLevel(
    profile: DeviceProfile,
    images: readonly SystemImage[],
    imageTag: string,
    requested: string | undefined,
  ): string {
    const tagged = images.filter(
      (image) =>
        image.tag === imageTag && (requested === undefined || image.apiLevel === requested),
    );
    if (tagged.length === 0) {
      throw new AndroidImageTagMissingError(requested ?? "default", imageTag);
    }
    const levels = fittingApiLevels(profile, tagged);
    const apiLevel = requested ?? levels.at(-1);
    if (apiLevel === undefined || !levels.includes(apiLevel)) {
      throw this.#systemImages.noFittingImage(profile, images, requested, imageTag);
    }
    return apiLevel;
  }
}

function fittingApiLevels(profile: DeviceProfile, images: readonly SystemImage[]): string[] {
  return installedApiLevels(images.filter((image) => fits(profile, image)));
}

function compareCatalogImages(left: DriverCatalogImage, right: DriverCatalogImage): number {
  return (
    compareApiLevels(left.runtime, right.runtime) ||
    left.tag.localeCompare(right.tag) ||
    left.abi.localeCompare(right.abi)
  );
}

/**
 * why: `devices.xml` is found the way `avdmanager` finds it: `ANDROID_USER_HOME`, else
 * `ANDROID_PREFS_ROOT/.android`, else `ANDROID_SDK_HOME/.android`, else `~/.android`. Not
 * `ANDROID_AVD_HOME`, which only relocates created AVDs.
 */
function userDevicesXmlPath(options: ProfileSourceInputs): string {
  const { ANDROID_PREFS_ROOT, ANDROID_SDK_HOME, ANDROID_USER_HOME } = options.env;
  return ANDROID_USER_HOME !== undefined
    ? `${ANDROID_USER_HOME}/devices.xml`
    : `${ANDROID_PREFS_ROOT ?? ANDROID_SDK_HOME ?? options.homeDirectory}/.android/devices.xml`;
}

function defaultDeviceProfileSources(
  options: ProfileSourceInputs,
  avdmanagerDevices: AvdmanagerDeviceList,
  onDiagnostic: ((diagnostic: DeviceProfileSourceDiagnostic) => void) | undefined,
): {
  readonly library: DeviceProfileSource;
  readonly builtin: DeviceProfileSource;
  readonly user: DeviceProfileSource;
} {
  return {
    library: new LibraryDeviceProfileSource(),
    builtin: new BuiltinDeviceProfileSource(avdmanagerDevices),
    user: new UserDeviceProfileSource(
      userDevicesXmlPath(options),
      options.filesystem,
      onDiagnostic,
    ),
  };
}
