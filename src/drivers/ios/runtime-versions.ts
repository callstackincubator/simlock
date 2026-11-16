import { RuntimeMissingError, UnknownModelError } from "../../core/index.js";
import {
  type DeviceType,
  type Runtime,
  type SimctlCatalog,
  UNBOUNDED_VERSION,
} from "./simctl-parse.js";

export const LATEST_COMPONENT = "latest";

// why: `xcodebuild -downloadPlatform iOS -buildVersion` only reaches back to iOS 16.0 (Xcode
// 16.1+); older runtimes must be installed through Xcode itself.
const IOS_DOWNLOAD_FLOOR: readonly [number, number, number] = [16, 0, 0];

export function missingRuntime(
  osVersion: string,
  message: string,
  component: string,
): RuntimeMissingError {
  return belowDownloadFloor(component)
    ? new IosDownloadFloorError(component)
    : new IosRuntimeMissingError(osVersion, message, component);
}

export function belowDownloadFloor(component: string): boolean {
  return component !== LATEST_COMPONENT && isTooOldToDownload(component);
}

class IosRuntimeMissingError extends RuntimeMissingError {
  constructor(osVersion: string, message: string, component: string) {
    super("ios", osVersion, { component });
    this.message = message;
  }
}

export class IosUnknownModelError extends UnknownModelError {
  constructor(model: string) {
    super("ios", model);
    this.message = `Unknown ios model: ${model}; a newer Xcode version may add this device`;
  }
}

export class IosVersionOutOfRangeError extends RuntimeMissingError {
  constructor(model: string, requested: string, deviceType: DeviceType) {
    super("ios", requested, { downloadable: false });
    const range = formatVersionRange(deviceType.minRuntimeVersion, deviceType.maxRuntimeVersion);
    this.message = `${model} supports iOS ${range}; iOS ${requested} is out of range`;
  }
}

export class IosRuntimeUnpairedError extends RuntimeMissingError {
  constructor(model: string, requested: string) {
    super("ios", requested, { downloadable: false });
    this.message = `iOS ${requested} is installed but does not support ${model}`;
  }
}

export class IosDownloadFloorError extends RuntimeMissingError {
  constructor(requested: string) {
    super("ios", requested, { downloadable: false });
    this.message =
      `iOS ${requested} predates Xcode's automatic download support (introduced for iOS ` +
      `16.0 and newer); install it manually via Xcode`;
  }
}

export class IosRuntimeUnavailableForDownloadError extends RuntimeMissingError {
  constructor(requested: string) {
    super("ios", requested, { downloadable: false });
    this.message =
      `iOS ${requested} is not currently offered for download by Apple (likely superseded by a ` +
      `newer point release); request a different --os, or omit --os for the newest available runtime`;
  }
}

export function runtimeForComponent(
  catalog: SimctlCatalog,
  component: string,
): Runtime | undefined {
  const available = catalog.runtimes.filter((runtime) => runtime.isAvailable);
  if (component === LATEST_COMPONENT) return newestRuntime(available);
  if (!component.includes(".")) {
    return newestRuntime(
      available.filter((runtime) => runtime.version.split(".")[0] === component),
    );
  }
  return findInstalledRuntime(catalog, component);
}

export function findInstalledRuntime(catalog: SimctlCatalog, version: string): Runtime | undefined {
  return catalog.runtimes.find((runtime) => runtime.isAvailable && runtime.version === version);
}

export function findDeviceType(catalog: SimctlCatalog, model: string): DeviceType | undefined {
  const wanted = model.toLocaleLowerCase();
  return catalog.deviceTypes.find((candidate) => candidate.name.toLocaleLowerCase() === wanted);
}

export function pairedInstalledRuntimes(
  catalog: SimctlCatalog,
  deviceType: DeviceType,
): readonly Runtime[] {
  return catalog.runtimes.filter(
    (runtime) =>
      runtime.isAvailable &&
      runtime.supportedDeviceTypeIds.has(deviceType.identifier) &&
      isVersionInRange(runtime.version, deviceType),
  );
}

export function findPairedRuntime(
  catalog: SimctlCatalog,
  deviceType: DeviceType,
  version: string,
): Runtime | undefined {
  return pairedInstalledRuntimes(catalog, deviceType).find(
    (runtime) => runtime.version === version,
  );
}

export function pairedVersions(
  catalog: SimctlCatalog,
  deviceType: DeviceType | undefined,
): string[] {
  if (deviceType === undefined) return [];
  return [
    ...new Set(pairedInstalledRuntimes(catalog, deviceType).map((runtime) => runtime.version)),
  ];
}

function decodeVersionTriple(encoded: number): readonly [number, number, number] {
  return [(encoded >> 16) & 0xff, (encoded >> 8) & 0xff, encoded & 0xff];
}

function formatDecodedVersion(encoded: number): string {
  const [major, minor, patch] = decodeVersionTriple(encoded);
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

export function isUnboundedMax(encoded: number): boolean {
  return encoded >= UNBOUNDED_VERSION;
}

function formatVersionRange(min: number, max: number): string {
  const minLabel = formatDecodedVersion(min);
  return isUnboundedMax(max) ? `${minLabel}+` : `${minLabel}-${formatDecodedVersion(max)}`;
}

function versionTriple(version: string): readonly [number, number, number] {
  const parts = version.split(".").map(versionPart);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function versionOrdinal(triple: readonly [number, number, number]): number {
  return triple[0] * 1_000_000 + triple[1] * 1_000 + triple[2];
}

export function isVersionInRange(version: string, deviceType: DeviceType): boolean {
  const ordinal = versionOrdinal(versionTriple(version));
  return (
    ordinal >= versionOrdinal(decodeVersionTriple(deviceType.minRuntimeVersion)) &&
    ordinal <= versionOrdinal(decodeVersionTriple(deviceType.maxRuntimeVersion))
  );
}

function isTooOldToDownload(version: string): boolean {
  return versionOrdinal(versionTriple(version)) < versionOrdinal(IOS_DOWNLOAD_FLOOR);
}

export function majorVersionString(encoded: number): string {
  return String(decodeVersionTriple(encoded)[0]);
}

export function newestRuntime(runtimes: readonly Runtime[]): Runtime | undefined {
  return [...runtimes].sort((left, right) => compareVersions(left.version, right.version)).at(-1);
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(versionPart);
  const rightParts = right.split(".").map(versionPart);
  const partCount = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return left.localeCompare(right);
}

function versionPart(part: string): number {
  const parsed = Number.parseInt(part, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
