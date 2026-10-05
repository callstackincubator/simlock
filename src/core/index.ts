export {
  type Config,
  type ConfigOverrides,
  // fallow-ignore-next-line unused-type -- public Config surface (config.mode, ADR 0005 §1); every in-tree reader gets it structurally off `Config`
  type DaemonMode,
  // fallow-ignore-next-line unused-type -- public Config surface (config.downloads.policy); no in-tree consumer names it directly yet
  type DownloadPolicy,
  effectiveAllowDownload,
  loadConfig,
  REDACTED_VALUE,
  redactConfig,
} from "./config.js";
export {
  DEVICE_CLASSES,
  type DeviceClass,
  type DeviceMode,
  type DeviceRecord,
  type DeviceSpec,
  type LeaseRecord,
  type LeaseRequestFailure,
  type Platform,
  IllegalTransition,
  transition,
  transitionEnteredAt,
} from "./domain.js";
export { buildCapacityFigures } from "./capacity/index.js";
export { type CleanupRule, type RegistryView } from "./cleanup/types.js";
export { automaticCleanupRules } from "./cleanup/rules.js";
export { CleanupReaper } from "./reaper.js";
export {
  BootTimeoutError,
  ComponentBusyError,
  ComponentInUseError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  ComponentInstallTimeoutError,
  ComponentNotOwnedError,
  type ComponentReceipt,
  type ComponentRemoval,
  COMPONENT_REMOVAL_TIMEOUT_MS,
  type DeviceRequest,
  type ExactDeviceRequest,
  DiskSpaceGuard,
  type Driver,
  type DriverAdvisory,
  type DriverCatalogEntry,
  type DriverComponent,
  DriverCrashError,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type DriverRejection,
  type DriverToolVersion,
  InsufficientDiskSpaceError,
  type InstalledComponent,
  type LegacyDevice,
  LicenseNotAcceptedError,
  type ObservedDevice,
  type ObservedRunState,
  type PassthroughCommand,
  type PrerequisiteCheck,
  PassthroughRefusedError,
  removeListedComponent,
  RuntimeMissingError,
  sameReceipt,
  UnknownModelError,
  UnsupportedRequestOptionError,
} from "./driver.js";
export {
  DriverCatalog,
  type ModelPreferences,
  UnknownPassthroughToolError,
} from "./driver-catalog.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary for Simlock's own adb server.
export type { AdbServerRejectionReason, DriverRejectionReason } from "./driver.js";
export { Doctor, isStalledTransition, type StallInput } from "./doctor.js";
export { type HostFacts, HostFactsReader } from "./host-facts.js";
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
export {
  IdempotencyConflictError,
  LeaseRequestForbiddenError,
  ReplayedLeaseRequestError,
} from "./lease-request-book.js";
export { Nuke } from "./nuke.js";
export { Registry, RegistryEventError, UnknownDeviceError, UnknownLeaseError } from "./registry.js";
export {
  ComponentInstaller,
  ComponentInstallerClosedError,
  type ComponentInstallerProgress,
} from "./component-installer.js";
export { SerializedDecision } from "./serialized-decision.js";
export {
  type CapacityReader,
  type CatalogReader,
  type DeviceModeReader,
  type LeaseCommands,
  type PassthroughResolver,
  type QueueControl,
} from "./lease-ports.js";
export {
  InMemoryLeaseRequestStore,
  LeaseRequestBook,
  type LeaseRequestLimits,
  newLeaseRequestId,
  type WaitingRequest,
} from "./lease-request-book.js";
export {
  type LeaseRequestOptions,
  type QueuePlace,
  type WaiterState,
  WaitQueue,
} from "./wait-queue.js";
export { findCatalogModel, modelClass, pairedRuntimes } from "./catalog-match.js";
export { type DeviceRequirement, fits, type LeaseGrant } from "./domain.js";
export {
  type DriverCatalogImage,
  type MissingPrerequisite,
  type ObservedMark,
  type PassthroughContext,
  type ReclaimResult,
} from "./driver.js";
export { createCore } from "./create-core.js";
