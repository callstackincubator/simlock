import { join } from "node:path";
import {
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  COMPONENT_REMOVAL_TIMEOUT_MS,
  type DriverAdvisory,
  type DriverToolVersion,
  type DriverComponent,
  DriverCrashError,
  type InstalledComponent,
  sameReceipt,
} from "../../core/index.js";
import type { Clock, Filesystem, ProcessRunner } from "../../ports/index.js";

import { COMMAND_TIMEOUT_MS, Simctl } from "./simctl.js";
import { DeviceMarks } from "./marks.js";
import { runBoundedProcess, runInstallerProcess } from "../installer-process.js";

import {
  IOS_RUNTIME_ASSET_ROOT,
  type RuntimeAsset,
  runtimeMountsAsset,
  parseRuntimeAsset,
  type RuntimeImage,
  isBeingDeleted,
  runtimeReceipt,
  imageReceipt,
  isIosImage,
  type ListedImage,
  leftoverDownloadsSentence,
  unavailableDevicesResidue,
  type DefaultSetDevices,
  devicesPerRuntime,
  installedComponent,
  withBareMajorHint,
} from "./runtime-images.js";
import {
  LATEST_COMPONENT,
  belowDownloadFloor,
  IosDownloadFloorError,
  IosRuntimeUnavailableForDownloadError,
  runtimeForComponent,
  findInstalledRuntime,
  compareVersions,
} from "./runtime-versions.js";
import { errorMessage } from "../../shared/index.js";

// why: `xcodebuild -version` answers in about a second; a first run after an Xcode update can take
// longer while it checks its components, and a hang must not hold host facts forever.
const XCODE_VERSION_TIMEOUT_MS = 15_000;

// why: How often a removal lists again while `simctl runtime list` shows the deleted image as still
// being deleted, which it does for a few seconds after `simctl runtime delete` answers (#259).
const DELETING_POLL_MS = 1_000;

interface RuntimeComponentsOptions {
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly marks: DeviceMarks;
  readonly processRunner: ProcessRunner;
  readonly simctl: Simctl;
}

/** why: the part of IosSimctlDriver (ADR 0063) that finds, installs, lists and removes the iOS runtimes, and reports the download cache they leave behind. */
export class RuntimeComponents {
  readonly #clock: Clock;
  readonly #filesystem: Filesystem;
  readonly #marks: DeviceMarks;
  readonly #processRunner: ProcessRunner;
  readonly #simctl: Simctl;

  constructor(options: RuntimeComponentsOptions) {
    this.#clock = options.clock;
    this.#filesystem = options.filesystem;
    this.#marks = options.marks;
    this.#processRunner = options.processRunner;
    this.#simctl = options.simctl;
  }

  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    const [catalog, images] = await Promise.all([
      this.#simctl.loadCatalog(),
      this.#simctl.loadRuntimeImages(),
    ]);
    const runtime = findInstalledRuntime(catalog, component);
    return runtime === undefined ? undefined : installedComponent(runtime, images);
  }

  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    if (belowDownloadFloor(component)) {
      throw new IosDownloadFloorError(component);
    }
    const before = await this.#installedReceipts();
    const args =
      component === LATEST_COMPONENT
        ? ["-downloadPlatform", "iOS"]
        : ["-downloadPlatform", "iOS", "-buildVersion", component];
    try {
      await this.#xcodebuildOrThrow(args, options);
    } catch (error: unknown) {
      throw withBareMajorHint(component, error);
    }

    const [catalog, images] = await Promise.all([
      this.#simctl.loadCatalog(),
      this.#simctl.loadRuntimeImages(),
    ]);
    const runtime = runtimeForComponent(catalog, component);
    if (runtime === undefined) {
      throw new DriverCrashError(
        `xcodebuild reported success but iOS ${component} is still not installed`,
      );
    }
    const installed = installedComponent(runtime, images);
    const wasThere = before.some((receipt) => sameReceipt(receipt, installed.receipt));
    return { ...installed, outcome: wasThere ? "already-installed" : "installed" };
  }

  async listComponents(): Promise<readonly DriverComponent[]> {
    return (await this.listedImages()).map(
      ({ image: _image, unusedDevices: _unused, ...component }) => component,
    );
  }

  async #deleteRuntimeImage(identifier: string, signal: AbortSignal): Promise<void> {
    const args = ["runtime", "delete", identifier];
    const command = `simctl ${args.join(" ")}`;
    let outcome;
    try {
      outcome = await runBoundedProcess(
        this.#processRunner,
        this.#clock,
        "xcrun",
        this.#simctl.scopedArgv(args),
        { signal, timeoutMs: COMPONENT_REMOVAL_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      throw new DriverCrashError(`${command} failed: ${errorMessage(error)}`);
    }
    if (outcome.timedOut) {
      throw new DriverCrashError(
        `${command} timed out after ${String(COMPONENT_REMOVAL_TIMEOUT_MS)}ms`,
      );
    }
    if (outcome.stopped) throw new DriverCrashError(`${command} was ended before it finished`);
    this.#simctl.assertSuccessful(args, outcome.result);
  }

  async #waitWhileDeleting(
    identifier: string,
    version: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const listed = (await this.#simctl.loadRuntimeImages()).find(
        (image) => image.identifier === identifier,
      );
      if (listed === undefined || !isBeingDeleted(listed)) return;
      const remainingMs = deadline - this.#clock.now();
      if (remainingMs <= 0) {
        throw new DriverCrashError(
          `ios ${version} was still being deleted ` +
            `${String(COMPONENT_REMOVAL_TIMEOUT_MS)}ms after its removal started`,
        );
      }
      if (!(await this.#pause(Math.min(DELETING_POLL_MS, remainingMs), signal))) {
        throw new DriverCrashError(
          `The removal of ios ${version} was ended while it was still being deleted`,
        );
      }
    }
  }

  #pause(delayMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.#clock.cancel(timer);
        resolve(false);
      };
      const timer = this.#clock.setTimer(delayMs, () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #downloadResidue(image: RuntimeImage, version: string): Promise<{ residue?: string }> {
    const left = (await this.#downloadedRuntimeAssets()).filter((asset) =>
      image.build === undefined ? asset.version === version : asset.build === image.build,
    );
    if (left.length === 0) return {};
    const label = image.build === undefined ? version : `${version} (${image.build})`;
    return {
      residue: leftoverDownloadsSentence([label], left.length, await this.#assetsSize(left)),
    };
  }

  async #assetsSize(assets: readonly RuntimeAsset[]): Promise<number | undefined> {
    let total = 0;
    for (const asset of assets) {
      try {
        total += await this.#filesystem.directorySize(asset.path);
      } catch {
        return undefined;
      }
    }
    return total;
  }

  async listedImages(): Promise<ListedImage[]> {
    const [images, defaultSet] = await Promise.all([
      this.#simctl.loadRuntimeImages(),
      this.#simctl.runLegacy(["list", "-j", "devices"], COMMAND_TIMEOUT_MS),
    ]);
    let foreign: ReadonlyMap<string, DefaultSetDevices>;
    try {
      const parsed = JSON.parse(defaultSet.stdout) as unknown;
      foreign = devicesPerRuntime(parsed, await this.#marks.ownedUdids(parsed));
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) throw error;
      throw new DriverCrashError(`Could not parse simctl device list: ${errorMessage(error)}`);
    }
    return images.filter(isIosImage).flatMap((image): ListedImage[] =>
      image.version === undefined
        ? []
        : [
            {
              foreignDevices: foreign.get(image.runtimeIdentifier)?.used ?? 0,
              image,
              unusedDevices: images.some(
                (other) =>
                  other !== image &&
                  isIosImage(other) &&
                  other.runtimeIdentifier === image.runtimeIdentifier,
              )
                ? 0
                : (foreign.get(image.runtimeIdentifier)?.unused ?? 0),
              receipt: imageReceipt(image),
              version: image.version,
              ...(image.build === undefined ? {} : { variant: image.build }),
              ...(image.sizeBytes === undefined ? {} : { sizeBytes: image.sizeBytes }),
            },
          ],
    );
  }

  async #installedReceipts(): Promise<readonly ComponentReceipt[]> {
    const [catalog, images] = await Promise.all([
      this.#simctl.loadCatalog(),
      this.#simctl.loadRuntimeImages(),
    ]);
    return catalog.runtimes
      .filter((runtime) => runtime.isAvailable)
      .map((runtime) => runtimeReceipt(runtime, images));
  }

  async #xcodebuildOrThrow(
    args: readonly string[],
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<void> {
    let outcome;
    try {
      outcome = await runInstallerProcess(
        this.#processRunner,
        this.#clock,
        "xcodebuild",
        args,
        options,
      );
    } catch (error: unknown) {
      throw new DriverCrashError(`xcodebuild ${args.join(" ")} failed: ${errorMessage(error)}`);
    }
    if (outcome.stopped) {
      throw new DriverCrashError(`xcodebuild ${args.join(" ")} was ended before it finished`);
    }
    const { result } = outcome;
    if (result.code === 0) {
      return;
    }
    const message = result.stderr || result.stdout;
    // why: Apple's downloader accepts `-buildVersion <marketing version>` only for whatever it
    // currently offers -- a pin naming a release Apple has since retired from its live catalog
    // (superseded by a newer point release), or one still ambiguous across several concurrent
    // beta/seed builds sharing the same marketing version, is rejected outright with "is not
    // available for download", distinct from every other `xcodebuild` failure this method
    // otherwise reports as a `DriverCrashError`. Falling back to an unpinned `-downloadPlatform
    // iOS` here would silently substitute whatever Apple currently offers instead -- a different,
    // unrequested, and possibly multi-gigabyte runtime -- for a request that named an exact
    // version, so this fails the request instead of guessing; see
    // `IosRuntimeUnavailableForDownloadError`.
    const buildVersionIndex = args.indexOf("-buildVersion");
    if (buildVersionIndex !== -1 && /is not available for download/.test(message)) {
      throw new IosRuntimeUnavailableForDownloadError(
        args[buildVersionIndex + 1] ?? "requested version",
      );
    }
    throw new DriverCrashError(`xcodebuild ${args.join(" ")} failed: ${message}`);
  }

  async toolVersions(): Promise<readonly DriverToolVersion[]> {
    const result = await this.#processRunner.run("xcodebuild", ["-version"], {
      timeoutMs: XCODE_VERSION_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      if (/requires Xcode/.test(result.stderr)) return [];
      throw new Error(`xcodebuild -version exited with ${String(result.code)}`);
    }
    const version = /^Xcode (\S+)$/m.exec(result.stdout)?.[1];
    const build = /^Build version (\S+)$/m.exec(result.stdout)?.[1];
    if (version === undefined) throw new Error("xcodebuild -version printed no Xcode version");
    return [{ name: "xcode", version, ...(build === undefined ? {} : { build }) }];
  }

  async cacheAdvisories(): Promise<readonly DriverAdvisory[]> {
    const assets = await this.#downloadedRuntimeAssets();

    if (assets.length === 0) {
      return [];
    }

    const installed = (await this.#simctl.loadCatalog()).runtimes.filter(
      (runtime) => runtime.isAvailable,
    );
    const orphans = assets.filter(
      (asset) => !installed.some((runtime) => runtimeMountsAsset(runtime, asset)),
    );

    if (orphans.length === 0) {
      return [];
    }

    // why: Oldest first, by version and then by build, so a store that has been collecting for
    // months reads in the order the downloads happened rather than as a lexicographic jumble.
    const described = [
      ...new Map(
        orphans.map((asset) => [`${asset.version} (${asset.build})`, asset] as const),
      ).entries(),
    ]
      .sort(
        ([, left], [, right]) =>
          compareVersions(left.version, right.version) || left.build.localeCompare(right.build),
      )
      .map(([label]) => label);
    return [
      {
        code: "runtime-cache-unreclaimable",
        message: leftoverDownloadsSentence(
          described,
          orphans.length,
          await this.#assetsSize(orphans),
        ),
      },
    ];
  }

  async #downloadedRuntimeAssets(): Promise<readonly RuntimeAsset[]> {
    let bundles: readonly string[];
    try {
      bundles = await this.#filesystem.readdir(IOS_RUNTIME_ASSET_ROOT);
    } catch {
      return [];
    }

    const assets: RuntimeAsset[] = [];
    for (const bundle of bundles.filter((name) => name.endsWith(".asset"))) {
      let contents: string;
      try {
        contents = await this.#filesystem.readFile(
          join(IOS_RUNTIME_ASSET_ROOT, bundle, "Info.plist"),
        );
      } catch {
        continue;
      }

      const asset = parseRuntimeAsset(join(IOS_RUNTIME_ASSET_ROOT, bundle), contents);
      if (asset !== undefined) {
        assets.push(asset);
      }
    }

    return assets;
  }

  /** why: the part of the runtime removal that runs after its seeds are gone: the runtime's own deletion, the wait while it is still being deleted, and the residue left behind. */
  async removeImage({ image, unusedDevices, version }: ListedImage, signal: AbortSignal) {
    // why: the budget is for the runtime's own deletion; a seed held by a late clone waits outside it.
    const deadline = this.#clock.now() + COMPONENT_REMOVAL_TIMEOUT_MS;
    await this.#deleteRuntimeImage(image.identifier, signal);
    await this.#waitWhileDeleting(image.identifier, version, deadline, signal);
    const sentences = [
      unavailableDevicesResidue(unusedDevices),
      (await this.#downloadResidue(image, version)).residue,
    ].filter((sentence) => sentence !== undefined);
    return sentences.length === 0 ? {} : { residue: sentences.join(". ") };
  }
}
