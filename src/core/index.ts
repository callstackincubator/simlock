export { type Config, type ConfigOverrides, loadConfig } from "./config.js";
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
  type Driver,
  type DriverCatalogEntry,
  DriverCrashError,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type DriverRejection,
  type ObservedDevice,
  type ObservedRunState,
  RuntimeMissingError,
  UnknownModelError,
} from "./driver.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary for Simlock's own adb server.
export type { AdbServerRejectionReason, DriverRejectionReason } from "./driver.js";
export { Doctor } from "./doctor.js";
export { ensureOwnedRoot, OWNED_ROOT_MARKER_FILE, OwnedRootError } from "./device-root.js";
// fallow-ignore-next-line unused-type -- public options contract for the drivers that own a root.
export type { EnsureOwnedRootOptions } from "./device-root.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary, carried in the driver.root-rejected payload.
export type { RootRejectionReason } from "./device-root.js";
// fallow-ignore-next-line unused-type -- public shape of the on-disk ownership marker.
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
  RequesterAlreadyLeasedError,
} from "./lease-engine.js";
export { LeaseHealthMonitor } from "./lease-health-monitor.js";
export { Nuke } from "./nuke.js";
export { FakeDriver, FakeDriverUnknownDeviceError } from "./fake-driver.js";
export { Registry, RegistryEventError, UnknownDeviceError, UnknownLeaseError } from "./registry.js";
