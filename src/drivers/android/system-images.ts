import { dirname, join } from "node:path";

import {
  COMPONENT_REMOVAL_TIMEOUT_MS,
  DriverCrashError,
  LicenseNotAcceptedError,
  RuntimeMissingError,
  sameReceipt,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type DriverComponent,
  type DriverToolVersion,
  type InstalledComponent,
} from "../../core/index.js";
import {
  isMissingPathError,
  type Clock,
  type Filesystem,
  type ProcessResult,
  type ProcessRunner,
} from "../../ports/index.js";
import { runBoundedProcess, runInstallerProcess } from "../installer-process.js";
import { iniValues } from "./avd-config.js";
import type { SystemImage } from "./data.js";
import { type DeviceProfile } from "./device-profile-source.js";
import { fits, misfitReason } from "./image-fit.js";
import type { AndroidSdkPaths } from "./sdk-paths.js";

// why: `sdkmanager --licenses` prompts once per outstanding license with a bare `y/N`. Answering
// more times than there are real licenses is harmless -- the extra `y`s land after the prompt
// loop has already exited and sdkmanager simply never reads them -- so this just needs to be
// comfortably above the largest real Android SDK license count rather than exact.
const LICENSE_ACCEPT_ANSWERS = 100;
// why: Conservative estimate for a system-image download+install -- reserved by `ComponentInstaller`
// before `sdkmanager --install` ever starts, so a full disk fails fast instead of filling up
// mid-download.
export const ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES = 2 * 1024 ** 3;

export class AndroidLicenseNotAcceptedError extends LicenseNotAcceptedError {
  constructor(readonly packageName: string) {
    super("android", packageName);
    this.message =
      `sdkmanager refused to install ${packageName}: an Android SDK license is not accepted. ` +
      `Set "downloads.acceptAndroidLicenses": true in config to accept automatically, or run ` +
      `\`sdkmanager --licenses\` manually.`;
    this.name = "AndroidLicenseNotAcceptedError";
  }
}

export interface SystemImagesOptions {
  readonly acceptAndroidLicenses: boolean;
  readonly clock: Clock;
  readonly deviceRoot: string;
  readonly filesystem: Filesystem;
  readonly hostAbi: string;
  readonly legacyAvdHome: string;
  readonly processRunner: ProcessRunner;
  readonly sdk: Pick<AndroidSdkPaths, "adb" | "emulator" | "root" | "sdkmanager">;
}

/** why: the part of AndroidDriver (ADR 0063) that owns no state and reads the SDK's system images and tool packages, and installs and uninstalls them through `sdkmanager`. */
export class SystemImages {
  readonly #acceptAndroidLicenses: boolean;
  readonly #clock: Clock;
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #hostAbi: string;
  readonly #legacyAvdHome: string;
  readonly #processRunner: ProcessRunner;
  readonly #sdk: SystemImagesOptions["sdk"];

  constructor(options: SystemImagesOptions) {
    this.#acceptAndroidLicenses = options.acceptAndroidLicenses;
    this.#clock = options.clock;
    this.#deviceRoot = options.deviceRoot;
    this.#filesystem = options.filesystem;
    this.#hostAbi = options.hostAbi;
    this.#legacyAvdHome = options.legacyAvdHome;
    this.#processRunner = options.processRunner;
    this.#sdk = options.sdk;
  }

  // fallow-ignore-next-line complexity -- one refusal builder: each branch is one message the spec lists.
  noFittingImage(
    profile: DeviceProfile,
    images: readonly SystemImage[],
    level: string | undefined,
    imageTag?: string,
  ): RuntimeMissingError {
    const considered = level === undefined ? images : images.filter((i) => i.apiLevel === level);
    const where = level === undefined ? "" : ` at Android ${level}`;
    const tagged = imageTag === undefined ? [] : considered.filter((i) => i.tag === imageTag);
    const downloadable =
      level !== undefined &&
      imageTag === undefined &&
      considered.length === 0 &&
      fits(profile, { apiLevel: level, tag: "google_apis", tags: ["google_apis"] });
    const error = downloadable
      ? new RuntimeMissingError("android", level, { component: level })
      : new RuntimeMissingError("android", level ?? "default", { downloadable: false });
    let reason: string;
    if (imageTag !== undefined) {
      const why = misfitReason(profile, tagged);
      reason = `the ${imageTag} image does not fit it${why === undefined ? "" : `: ${why}`}`;
    } else if (images.length === 0) {
      reason = "no system image is installed";
    } else if (considered.length === 0) {
      reason = `Android ${level} is not installed`;
    } else {
      reason = misfitReason(profile, considered) ?? "none of the installed images fit it";
    }
    error.message = `No installed system image fits ${profile.name}${where}: ${reason}`;
    return error;
  }

  async toolVersions(): Promise<readonly DriverToolVersion[]> {
    const packages = [
      { name: "emulator", path: dirname(this.#sdk.emulator) },
      { name: "platform-tools", path: dirname(this.#sdk.adb) },
      {
        name: this.#sdk.sdkmanager.includes("/cmdline-tools/") ? "cmdline-tools" : "tools",
        path: dirname(dirname(this.#sdk.sdkmanager)),
      },
    ];
    const versions = await Promise.all(
      packages.map(async ({ name, path }) => {
        const version = await packageRevision(this.#filesystem, path);
        return version === undefined ? undefined : { name, version };
      }),
    );
    return versions.filter((version) => version !== undefined);
  }

  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    const image = this.#matchingImage(await this.installedImages(), component, undefined);
    return image === undefined ? undefined : this.#installedComponent(image);
  }

  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    const packageName = systemImagePackage(component, "google_apis", this.#hostAbi);
    const before = await Promise.all(
      (await this.installedImages()).map(async (image) => this.#imageReceipt(image)),
    );
    await this.#installSystemImageOrThrow(packageName, options);

    const image = (await this.installedImages()).find(
      (candidate) =>
        systemImagePackage(candidate.apiLevel, candidate.tag, candidate.abi) === packageName,
    );
    if (image === undefined) {
      throw new DriverCrashError(
        `sdkmanager reported success but ${packageName} is still not installed`,
      );
    }
    const installed = await this.#installedComponent(image);
    const wasThere = before.some((receipt) => sameReceipt(receipt, installed.receipt));
    return { ...installed, outcome: wasThere ? "already-installed" : "installed" };
  }

  async listComponents(): Promise<readonly DriverComponent[]> {
    return (await this.listedImages()).map(({ image: _image, ...component }) => component);
  }

  async uninstall(packageName: string, options: { readonly signal: AbortSignal }): Promise<void> {
    const command = `${this.#sdk.sdkmanager} --uninstall ${packageName}`;
    let outcome;
    try {
      outcome = await runBoundedProcess(
        this.#processRunner,
        this.#clock,
        this.#sdk.sdkmanager,
        ["--uninstall", packageName],
        { signal: options.signal, timeoutMs: COMPONENT_REMOVAL_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      throw new DriverCrashError(
        `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (outcome.timedOut) {
      throw new DriverCrashError(
        `${command} timed out after ${String(COMPONENT_REMOVAL_TIMEOUT_MS)}ms`,
      );
    }
    if (outcome.stopped) throw new DriverCrashError(`${command} was ended before it finished`);
    if (outcome.result.code !== 0) {
      throw new DriverCrashError(
        `${command} failed: ${outcome.result.stderr || outcome.result.stdout}`,
      );
    }
  }

  async listedImages(): Promise<(DriverComponent & { readonly image: SystemImage })[]> {
    const [images, foreignAvds] = await Promise.all([
      this.installedImages(),
      this.#foreignAvdImageDirectories(),
    ]);
    return Promise.all(
      images.map(async (image): Promise<DriverComponent & { readonly image: SystemImage }> => {
        const sizeBytes = await this.#filesystem.directorySize(image.path).catch(() => undefined);
        const directories = [image.path, relativeImageDirectory(image)];
        return {
          ...(await this.#installedComponent(image)),
          image,
          foreignDevices: foreignAvds.filter((named) =>
            named.some((directory) => directories.includes(directory)),
          ).length,
          variant: `${image.tag}/${image.abi}`,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        };
      }),
    );
  }

  /**
   * why: For every AVD in the user's own AVD home, the image directories its `config.ini` names
   * (`image.sysdir.N`), without trailing slashes. Read-only (safety rule 1). A home or a
   * `config.ini` that does not exist names no image. Any other read failure rejects: a count that
   * silently left an AVD out would read as "nothing of the user's uses this image". A home that is
   * this driver's own root -- the daemon started from a lease's environment -- holds Simlock's
   * AVDs, which the registry counts, and none of the user's.
   */
  async #foreignAvdImageDirectories(): Promise<readonly (readonly string[])[]> {
    const home = this.#legacyAvdHome;
    if (home === this.#deviceRoot) return [];
    let entries: string[];
    try {
      entries = await this.#filesystem.readdir(home);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
    const avds = entries
      .filter((entry) => entry.endsWith(".ini"))
      .map(async (entry) => {
        const pointer = await this.#filesystem.readFile(join(home, entry));
        const avdPath =
          iniValues(pointer, /^path$/)[0] ?? join(home, `${entry.slice(0, -".ini".length)}.avd`);
        const config = await this.#readIfPresent(join(avdPath, "config.ini"));
        if (config === undefined) return [];
        return iniValues(config, /^image\.sysdir\.\d+$/).map((value) => value.replace(/\/+$/, ""));
      });
    return Promise.all(avds);
  }

  async #readIfPresent(path: string): Promise<string | undefined> {
    try {
      return await this.#filesystem.readFile(path);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  async #installedComponent(image: SystemImage): Promise<InstalledComponent> {
    return { receipt: await this.#imageReceipt(image), version: image.apiLevel };
  }

  /**
   * why: The one function that builds this driver's receipt (ADR 0010 §5): the package, its
   * revision, and a stamp of the image's own `source.properties` -- which file it is and when it
   * was written -- so an image deleted and installed again at the same revision differs.
   */
  async #imageReceipt(image: SystemImage): Promise<ComponentReceipt> {
    let stamp = "";
    try {
      const stat = await this.#filesystem.stat(`${image.path}/source.properties`);
      stamp = `${stat.identity}@${String(stat.modifiedAtMs)}`;
    } catch {}
    return {
      package: systemImagePackage(image.apiLevel, image.tag, image.abi),
      revision: image.version,
      stamp,
    };
  }

  /**
   * why: Installs a system image, accepting Android SDK licenses first when `sdkmanager` refuses
   * on an unaccepted one and `acceptAndroidLicenses` allows it -- never otherwise: license
   * consent is independent of, and never implied by, download permission.
   */
  async #installSystemImageOrThrow(
    packageName: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<void> {
    const result = await this.#sdkmanager(["--install", packageName], options);
    if (result.code === 0 && !hasUnacceptedLicense(result)) {
      return;
    }
    if (!hasUnacceptedLicense(result)) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --install ${packageName} failed: ${result.stderr || result.stdout}`,
      );
    }
    if (!this.#acceptAndroidLicenses) {
      throw new AndroidLicenseNotAcceptedError(packageName);
    }

    await this.#acceptLicenses(options);

    const retry = await this.#sdkmanager(["--install", packageName], options);
    if (retry.code !== 0 || hasUnacceptedLicense(retry)) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --install ${packageName} still failed after accepting licenses: ` +
          `${retry.stderr || retry.stdout}`,
      );
    }
  }

  async #acceptLicenses(options: {
    readonly onProgress: (progress: ComponentInstallProgress) => void;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const result = await this.#sdkmanager(["--licenses"], {
      ...options,
      // why: `sdkmanager --licenses` prompts once per outstanding license; answering more times
      // than there are real licenses is harmless (see `LICENSE_ACCEPT_ANSWERS`).
      input: "y\n".repeat(LICENSE_ACCEPT_ANSWERS),
    });
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --licenses failed: ${result.stderr || result.stdout}`,
      );
    }
  }

  async #sdkmanager(
    args: readonly string[],
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
      readonly input?: string;
    },
  ): Promise<ProcessResult> {
    let outcome;
    try {
      outcome = await runInstallerProcess(
        this.#processRunner,
        this.#clock,
        this.#sdk.sdkmanager,
        args,
        options,
      );
    } catch (error: unknown) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} ${args.join(" ")} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (outcome.stopped) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} ${args.join(" ")} was ended before it finished`,
      );
    }
    return outcome.result;
  }

  async installedImages(): Promise<SystemImage[]> {
    const root = `${this.#sdk.root}/system-images`;
    if (!(await this.#filesystem.exists(root))) {
      return [];
    }

    const images: SystemImage[] = [];
    for (const apiDirectory of await this.#filesystem.readdir(root)) {
      const apiMatch = /^android-(.+)$/.exec(apiDirectory);
      if (apiMatch?.[1] === undefined) {
        continue;
      }
      const apiPath = `${root}/${apiDirectory}`;
      // why: A dot entry (`.DS_Store`, an editor's swap file) is never a tag or an ABI.
      for (const tag of (await this.#filesystem.readdir(apiPath)).filter(isVisibleEntry)) {
        const tagPath = `${apiPath}/${tag}`;
        for (const abi of (await this.#filesystem.readdir(tagPath)).filter(isVisibleEntry)) {
          const path = `${tagPath}/${abi}`;
          const properties = await readSourceProperties(this.#filesystem, path);
          const sourceApiLevel = sourcePropertyValue(properties, "AndroidVersion.ApiLevel");
          images.push({
            abi,
            apiLevel: apiMatch[1],
            path,
            ...(sourceApiLevel === undefined ? {} : { sourceApiLevel }),
            tag,
            tags: systemImageTags(properties, tag),
            version: await systemImageVersion(this.#filesystem, path),
          });
        }
      }
    }
    return images;
  }

  #matchingImage(
    images: readonly SystemImage[],
    apiLevel: string,
    imageTag: string | undefined,
  ): SystemImage | undefined {
    const matching = images.filter((image) => image.apiLevel === apiLevel);
    if (imageTag !== undefined) {
      const tagged = matching.filter((image) => image.tag === imageTag);
      return tagged.find((image) => image.abi === this.#hostAbi) ?? tagged[0];
    }
    return (
      matching.find((image) => image.tag === "google_apis" && image.abi === this.#hostAbi) ??
      matching.find((image) => image.abi === this.#hostAbi) ??
      matching.find((image) => image.tag === "google_apis") ??
      matching[0]
    );
  }

  async requireImage(
    profile: DeviceProfile,
    apiLevel: string,
    imageTag: string | undefined,
  ): Promise<SystemImage> {
    const images = await this.installedImages();
    const image = this.#matchingImage(
      images.filter((candidate) => fits(profile, candidate)),
      apiLevel,
      imageTag,
    );
    if (image === undefined) {
      if (
        imageTag !== undefined &&
        !images.some((i) => i.apiLevel === apiLevel && i.tag === imageTag)
      ) {
        throw new AndroidImageTagMissingError(apiLevel, imageTag);
      }
      throw this.noFittingImage(profile, images, apiLevel, imageTag);
    }
    return image;
  }
}

/**
 * why: No installed image of the requested tag for the API level. Never downloadable: a component is
 * an API level, not a tag, so `--allow-download` cannot supply it; the operator installs it with
 * `sdkmanager`.
 */
export class AndroidImageTagMissingError extends RuntimeMissingError {
  constructor(apiLevel: string, imageTag: string) {
    super("android", apiLevel, { downloadable: false });
    this.message =
      apiLevel === "default"
        ? `No ${imageTag} system image is installed for any Android API level`
        : `No ${imageTag} system image is installed for Android API ${apiLevel}`;
  }
}

export function installedApiLevels(images: readonly SystemImage[]): string[] {
  // why: a preview folder (`Baklava`) ranks by the highest level any of its images records, so an
  // image that records none cannot make the preview outrank a numeric level.
  const rank = new Map<string, string>();
  for (const image of images) {
    const level = /^\d/.test(image.apiLevel) ? image.apiLevel : image.sourceApiLevel;
    const current = rank.get(image.apiLevel);
    if (level !== undefined && (current === undefined || compareApiLevels(level, current) > 0)) {
      rank.set(image.apiLevel, level);
    }
  }
  return [...new Set(images.map((image) => image.apiLevel))].sort(
    (left, right) =>
      compareApiLevels(rank.get(left) ?? left, rank.get(right) ?? right) ||
      left.localeCompare(right),
  );
}

function isVisibleEntry(name: string): boolean {
  return !name.startsWith(".");
}

export function compareApiLevels(left: string, right: string): number {
  const numericDifference = Number(left) - Number(right);
  return Number.isNaN(numericDifference) || numericDifference === 0
    ? left.localeCompare(right)
    : numericDifference;
}

export function systemImagePackage(apiLevel: string, tag: string, abi: string): string {
  return `system-images;android-${apiLevel};${tag};${abi}`;
}

async function systemImageVersion(filesystem: Filesystem, imagePath: string): Promise<string> {
  return (await packageRevision(filesystem, imagePath)) ?? "unknown";
}

async function packageRevision(
  filesystem: Filesystem,
  packagePath: string,
): Promise<string | undefined> {
  try {
    const properties = await filesystem.readFile(`${packagePath}/source.properties`);
    const revision = properties
      .split(/\r?\n/)
      .find((line) => line.startsWith("Pkg.Revision="))
      ?.slice("Pkg.Revision=".length)
      .trim();
    return revision === "" ? undefined : revision;
  } catch {
    return undefined;
  }
}

function relativeImageDirectory(image: SystemImage): string {
  return `system-images/android-${image.apiLevel}/${image.tag}/${image.abi}`;
}

async function readSourceProperties(
  filesystem: Filesystem,
  imagePath: string,
): Promise<string | undefined> {
  try {
    return await filesystem.readFile(`${imagePath}/source.properties`);
  } catch {
    return undefined;
  }
}

function sourcePropertyValue(properties: string | undefined, key: string): string | undefined {
  const value = properties
    ?.split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim();
  return value === undefined || value === "" ? undefined : value;
}

function systemImageTags(properties: string | undefined, folder: string): readonly string[] {
  const tags = (sourcePropertyValue(properties, "SystemImage.TagId") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return tags.length > 0 ? tags : [folder];
}

/**
 * why: `sdkmanager --install` reports an unaccepted license in its output rather than through a
 * dedicated exit code, so this is a best-effort text match against sdkmanager's own wording
 * (e.g. `Warning: License for package ... not accepted.` /
 * `... licenses have not been accepted.`), checked across both streams since sdkmanager splits
 * its output between them across versions.
 */
function hasUnacceptedLicense(result: ProcessResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`;
  // why: Covers both documented sdkmanager phrasings: "License for package ... not accepted." and
  // "licenses have not been accepted." -- the latter has "been" between "not" and "accepted".
  return /licen[cs]e/i.test(combined) && /not (?:been )?accepted/i.test(combined);
}
