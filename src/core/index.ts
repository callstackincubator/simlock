export {
  type Config,
  type ConfigOverrides,
  // fallow-ignore-next-line unused-type -- public Config surface (config.mode, ADR 0005 §1); every in-tree reader gets it structurally off `Config`
  type DaemonMode,
  // fallow-ignore-next-line unused-type -- public Config surface (config.downloads.policy); no in-tree consumer names it directly yet
  type DownloadPolicy,
  effectiveAllowDownload,
  loadConfig,
} from "./config.js";
export {
  type DeviceRecord,
  type DeviceSpec,
  type LeaseRecord,
  IllegalTransition,
  transition,
  transitionEnteredAt,
} from "./domain.js";
export { type CleanupRule, type RegistryView } from "./cleanup/types.js";
export { automaticCleanupRules } from "./cleanup/rules.js";
export { CleanupReaper } from "./reaper.js";
export {
  BootTimeoutError,
  type DeviceRequest,
  DiskSpaceGuard,
  type Driver,
  type DriverAdvisory,
  type DriverCatalogEntry,
  DriverCrashError,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type DriverRejection,
  InsufficientDiskSpaceError,
  type LegacyDevice,
  LicenseNotAcceptedError,
  type ObservedDevice,
  type ObservedRunState,
  type PassthroughCommand,
  PassthroughRefusedError,
  RuntimeMissingError,
  UnknownModelError,
} from "./driver.js";
export { UnknownPassthroughToolError } from "./driver-catalog.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary for Simlock's own adb server.
export type { AdbServerRejectionReason, DriverRejectionReason } from "./driver.js";
export { Doctor } from "./doctor.js";
export { ensureOwnedRoot, OWNED_ROOT_MARKER_FILE, OwnedRootError } from "./device-root.js";
export type { EnsureOwnedRootOptions } from "./device-root.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary, carried in the driver.root-rejected payload.
export type { RootRejectionReason } from "./device-root.js";
export type { OwnedRootMarker } from "./device-root.js";
export { InstanceIdentityError, loadInstanceId } from "./instance-identity.js";
// fallow-ignore-next-line unused-type -- public options contract for the daemon composition root.
export type { InstanceIdentityOptions } from "./instance-identity.js";
export {
  LeaseEngine,
  type LeaseProgress,
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
} from "./lease-engine.js";
export { LeaseHealthMonitor } from "./lease-health-monitor.js";
export { Nuke } from "./nuke.js";
export { FakeDriver, FakeDriverUnknownDeviceError } from "./fake-driver.js";
export { Registry, RegistryEventError, UnknownDeviceError, UnknownLeaseError } from "./registry.js";
