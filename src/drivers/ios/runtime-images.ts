import {
  type ComponentReceipt,
  type DriverComponent,
  DriverCrashError,
  type InstalledComponent,
} from "../../core/index.js";
import { isRecord, type Runtime } from "./simctl-parse.js";
import { LATEST_COMPONENT } from "./runtime-versions.js";

// why: Conservative estimate for a simulator runtime download+install (~7 GB observed, rounded up
// with headroom) -- reserved by `ComponentInstaller` before `xcodebuild -downloadPlatform` ever
// starts, so a full disk fails fast instead of filling up mid-download.
export const IOS_RUNTIME_MIN_FREE_BYTES = 8 * 1024 ** 3;

// why: Where macOS's own asset daemon keeps every simulator runtime it has ever downloaded, one
// `<uuid>.asset` bundle per build. `simctl runtime delete` only unregisters a runtime from
// CoreSimulator; the bundle it was mounted from stays here, marked never-collected, spending
// the same free space `IOS_RUNTIME_MIN_FREE_BYTES` measures. Nothing Simlock may do can
// reclaim it (issue #79), so the driver only ever reads this path.
export const IOS_RUNTIME_ASSET_ROOT =
  "/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime";

export interface RuntimeAsset {
  readonly path: string;
  readonly version: string;
  readonly build: string;
}

export function runtimeMountsAsset(runtime: Runtime, asset: RuntimeAsset): boolean {
  return runtime.build === undefined
    ? runtime.version === asset.version
    : runtime.build === asset.build;
}

/**
 * why: The build and marketing version out of an asset bundle's `Info.plist`. Read as text rather
 * than through a plist parser: these are two flat string values in a file this driver must
 * never write, and shelling out to `plutil` once per bundle would make a `doctor` run pay for
 * every runtime ever downloaded. Both keys are read from `MobileAssetProperties` onwards, so a
 * same-named key in the surrounding envelope cannot be mistaken for the asset's own.
 */
export function parseRuntimeAsset(path: string, plist: string): RuntimeAsset | undefined {
  const propertiesAt = plist.indexOf("<key>MobileAssetProperties</key>");
  const properties = propertiesAt === -1 ? plist : plist.slice(propertiesAt);
  const build = /<key>Build<\/key>\s*<string>([^<]+)<\/string>/.exec(properties)?.[1];
  const version = /<key>SimulatorVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(properties)?.[1];

  return build === undefined || version === undefined ? undefined : { build, path, version };
}

export interface RuntimeImage {
  readonly identifier: string;
  readonly runtimeIdentifier: string;
  readonly build?: string;
  readonly platformIdentifier?: string;
  readonly version?: string;
  readonly sizeBytes?: number;
  readonly state?: string;
}

export function isBeingDeleted(image: RuntimeImage): boolean {
  return image.state?.toLowerCase() === "deleting";
}

const IOS_SIMULATOR_PLATFORM = "com.apple.platform.iphonesimulator";

export function parseRuntimeImages(value: unknown): readonly RuntimeImage[] {
  if (!isRecord(value)) {
    throw new DriverCrashError("Invalid simctl runtime list JSON: expected an object");
  }
  return Object.values(value).flatMap((entry): RuntimeImage[] =>
    isRecord(entry) &&
    typeof entry.identifier === "string" &&
    typeof entry.runtimeIdentifier === "string"
      ? [
          {
            identifier: entry.identifier,
            runtimeIdentifier: entry.runtimeIdentifier,
            ...optionalString("build", entry.build),
            ...optionalString("platformIdentifier", entry.platformIdentifier),
            ...optionalString("version", entry.version),
            ...optionalString("state", entry.state),
            ...(isByteCount(entry.sizeBytes) ? { sizeBytes: entry.sizeBytes } : {}),
          },
        ]
      : [],
  );
}

function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  return typeof value === "string" ? ({ [key]: value } as Record<Key, string>) : {};
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function runtimeReceipt(
  runtime: Runtime,
  images: readonly RuntimeImage[],
): ComponentReceipt {
  const image = images.find(
    (candidate) =>
      candidate.runtimeIdentifier === runtime.identifier &&
      (runtime.build === undefined || candidate.build === runtime.build),
  );
  return image === undefined
    ? { build: runtime.build ?? "", runtime: runtime.identifier }
    : imageReceipt(image);
}

export function imageReceipt(image: RuntimeImage): ComponentReceipt {
  return { build: image.build ?? "", image: image.identifier };
}

export function isIosImage(image: RuntimeImage): boolean {
  return image.platformIdentifier === IOS_SIMULATOR_PLATFORM;
}

export type ListedImage = DriverComponent & {
  readonly image: RuntimeImage;
  readonly unusedDevices: number;
};

export function leftoverDownloadsSentence(
  labels: readonly string[],
  bundles: number,
  sizeBytes: number | undefined,
): string {
  const runtimes = labels.length > 1;
  const downloads = bundles > 1;
  const size =
    sizeBytes === undefined
      ? ""
      : ` (${(sizeBytes / 1024 ** 3).toFixed(1)} GiB${downloads ? " in all" : ""})`;
  return (
    `iOS ${labels.join(", ")} ${runtimes ? "are" : "is"} no longer installed, but ` +
    `${runtimes ? "their" : "its"} ${downloads ? "downloads" : "download"}${size} ` +
    `${downloads ? "are" : "is"} still in ${IOS_RUNTIME_ASSET_ROOT}; ` +
    `\`simctl runtime delete\` does not reclaim ${downloads ? "them" : "it"} and Simlock does ` +
    "not delete files there -- remove the platform in Xcode's Settings -> Platforms to get " +
    "the space back"
  );
}

export function unavailableDevicesResidue(unused: number): string | undefined {
  if (unused === 0) return undefined;
  const subject =
    unused === 1
      ? "1 never-used simulator in the default device set is"
      : `${String(unused)} never-used simulators in the default device set are`;
  return (
    `${subject} now unavailable; Simlock does not delete simulators there -- ` +
    "`xcrun simctl delete unavailable` clears them"
  );
}

export interface DefaultSetDevices {
  readonly used: number;
  readonly unused: number;
}

export function devicesPerRuntime(
  value: unknown,
  owned: ReadonlySet<string>,
): ReadonlyMap<string, DefaultSetDevices> {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  return new Map(
    Object.entries(value.devices).map(([runtime, devices]): [string, DefaultSetDevices] => {
      const entries: readonly unknown[] = (Array.isArray(devices) ? devices : []).filter(
        (device: unknown) => !(isRecord(device) && owned.has(String(device.udid))),
      );
      const used = entries.filter(
        (device) => !isRecord(device) || device.lastUsedAt !== undefined,
      ).length;
      return [runtime, { unused: entries.length - used, used }];
    }),
  );
}

export function installedComponent(
  runtime: Runtime,
  images: readonly RuntimeImage[],
): InstalledComponent {
  return { receipt: runtimeReceipt(runtime, images), version: runtime.version };
}

export function withBareMajorHint(component: string, error: unknown): unknown {
  if (component === LATEST_COMPONENT || component.includes(".")) return error;
  if (!(error instanceof DriverCrashError)) return error;
  return new DriverCrashError(
    `Could not download a default iOS runtime (tried ${component}): ${error.message}; ` +
      `pass --os <version> to request an exact release`,
  );
}
