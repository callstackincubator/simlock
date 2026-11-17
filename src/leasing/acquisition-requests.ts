import { compareVersions, type OsRange, parseOsConstraint, satisfies } from "../contract/index.js";
import {
  type ComponentInstallerProgress,
  type LeaseProgress,
  type DeviceRequest,
  type DeviceRequirement,
  type DriverCatalogEntry,
  pairedRuntimes,
  type PhysicalRequest,
  RuntimeMissingError,
  type VirtualSpec,
} from "../core/index.js";

export function physicalRequestOf(request: DeviceRequest): PhysicalRequest {
  return {
    platform: request.platform,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.class === undefined ? {} : { class: request.class }),
    ...(request.osVersion === undefined ? {} : { osVersion: request.osVersion }),
  };
}

export function fullSpec(spec: VirtualSpec): VirtualSpec {
  if (spec.mode === undefined) return spec;
  const { mode: _mode, ...full } = spec;
  return full;
}

export type DownloadingProgress = Extract<LeaseProgress, { readonly stage: "downloading" }>;

export function downloadingProgress(
  component: string,
  progress: ComponentInstallerProgress,
): DownloadingProgress {
  if (progress.stage === "waiting") return { component, stage: "downloading", waiting: true };
  const { percent } = progress;
  return percent === undefined
    ? { component, stage: "downloading", waiting: false }
    : { component, percent: Math.floor(percent), stage: "downloading", waiting: false };
}

/** why: both reports are for the one component a `#resolveOrInstall` call downloads. */
export function sameDownloadingProgress(
  left: DownloadingProgress,
  right: DownloadingProgress,
): boolean {
  return left.waiting === right.waiting && left.percent === right.percent;
}

export function matchingRuntimes(
  entry: DriverCatalogEntry,
  model: string,
  { imageTag, osVersion }: Pick<DeviceRequest, "imageTag" | "osVersion">,
  range: OsRange | undefined,
): string[] {
  return pairedRuntimes(entry, model).filter(
    (runtime) =>
      (range === undefined
        ? osVersion === undefined || runtime === osVersion
        : satisfies(runtime, range)) &&
      (imageTag === undefined ||
        (entry.images ?? []).some((image) => image.runtime === runtime && image.tag === imageTag)),
  );
}

/** why: the newest runtime `model` pairs with that the request's range accepts, or none installed. */
export function newestRuntime(
  entry: DriverCatalogEntry,
  model: string,
  request: DeviceRequest,
  range: OsRange,
): string {
  const newest = matchingRuntimes(entry, model, request, range).sort(compareVersions).at(-1);
  if (newest === undefined) throw new RuntimeMissingError(request.platform, range.text);
  return newest;
}

/** why: what a device's OS must satisfy: the range, the exact version named, or any installed runtime. */
export function requiredOs(
  entry: DriverCatalogEntry,
  { osVersion }: DeviceRequest,
  range: OsRange | undefined,
): DeviceRequirement["osVersion"] {
  if (range !== undefined) return range;
  return osVersion === undefined
    ? { kind: "installed", versions: entry.runtimes }
    : { kind: "exact", version: osVersion };
}

/** why: the request's OS range, when its `osVersion` is one rather than an exact version. */
export function requestedRange(request: DeviceRequest): OsRange | undefined {
  if (request.osVersion === undefined) return undefined;
  const parsed = parseOsConstraint(request.osVersion);
  return parsed.ok && parsed.constraint.kind === "range" ? parsed.constraint : undefined;
}
