export {
  type Config,
  type ConfigOverrides,
  // fallow-ignore-next-line unused-type -- public Config surface (config.mode, ADR 0005 §1); every in-tree reader gets it structurally off `Config`
  type DaemonMode,
  // fallow-ignore-next-line unused-type -- public Config surface (config.downloads.policy); no in-tree consumer names it directly yet
  type DownloadPolicy,
  effectiveAllowDownload,
  loadConfig,
  type ModuleConfigEntry,
  REDACTED_VALUE,
  redactConfig,
} from "./config.js";
export {
  type AbsentReason,
  DEVICE_CLASSES,
  type DeviceClass,
  type DeviceMode,
  type DeviceRecord,
  type DeviceSpec,
  type LeaseRecord,
  type LeaseRequestFailure,
  type PhysicalClass,
  type Platform,
  type VirtualDevice,
  type VirtualSpec,
  IllegalTransition,
  transition,
  transitionEnteredAt,
} from "./domain.js";
export {
  buildCapacityFigures,
  CapacityCoordinator,
  type CapacityRefusalReason,
  capacityDevice,
  capacityDevices,
  type CapacityReservation,
  plannedCapacityDevice,
} from "./capacity/index.js";
export { automaticCleanupRules, type CleanupRule, type RegistryView } from "./cleanup/index.js";
export { CleanupReaper } from "./reaper.js";
export { integerInRange, invalidValue, nonEmptyString, objectValidator } from "./validation.js";
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
  isPhysicalDriverDevice,
  type PhysicalDriverDevice,
  type DriverRefusalReason,
  type VirtualDriverDevice,
  type PhysicalInspection,
  type PresentPhysical,
  toDriverDevice,
  uninstallPlan,
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
  NoDriverError,
  type ModelPreferences,
  type ScreenAvailability,
  UnknownPassthroughToolError,
} from "./driver-catalog.js";
export {
  encodeScreenFrame,
  encodeScreenMeta,
  type ScreenCapture,
  type ScreenFeed,
  SCREEN_FRAME_HEADER_BYTES,
  SCREEN_FRAME_TAG,
  type ScreenMeta,
  ScreenNotSupportedError,
  type ScreenSettings,
  ScreenUnavailableError,
} from "./screen.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary for Simlock's own adb server.
export type { AdbServerRejectionReason, DriverRejectionReason } from "./driver.js";
export {
  Doctor,
  isStalledTransition,
  type OptionalModuleFinding,
  type StallInput,
} from "./doctor.js";
export { StartupRead } from "./startup-read.js";
export { type HostFacts, HostFactsReader } from "./host-facts.js";
export { ensureOwnedRoot, OWNED_ROOT_MARKER_FILE, OwnedRootError } from "./device-root.js";
export type { EnsureOwnedRootOptions } from "./device-root.js";
// fallow-ignore-next-line unused-type -- wire-visible rejection vocabulary, carried in the driver.root-rejected payload.
export type { RootRejectionReason } from "./device-root.js";
export type { OwnedRootMarker } from "./device-root.js";
export { InstanceIdentityError, loadInstanceId } from "./instance-identity.js";
// fallow-ignore-next-line unused-type -- public options contract for the daemon composition root.
export type { InstanceIdentityOptions } from "./instance-identity.js";
export { Nuke } from "./nuke.js";
export { type NukeExecutor } from "./core-ports.js";
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
  type LeaseExpirer,
  type PassthroughResolver,
  type WarmPoolReader,
} from "./core-ports.js";
export { findCatalogModel, modelClass, pairedRuntimes } from "./catalog-match.js";
export {
  type DeviceRequirement,
  type FittableSpec,
  fits,
  fitsPhysical,
  type LeaseGrant,
  noPhysicalMatch,
  type PhysicalDevice,
  type PhysicalRequest,
} from "./domain.js";
export {
  type LatestPresence,
  latestPresence,
  type PhysicalRead,
  readPhysicalPresence,
  readPhysicalPresenceDetail,
} from "./physical-presence.js";
export {
  type DriverCatalogImage,
  type MissingPrerequisite,
  type ObservedMark,
  type PassthroughContext,
  type ReclaimResult,
} from "./driver.js";
export { type Core, type CorePorts, createCore } from "./create-core.js";
export { DeviceOperationClaims, type DeviceOperationClaim } from "./device-operation-claims.js";
export {
  DeviceBusyError,
  DeviceNotEnrollableError,
  PhysicalEnrollment,
  UnknownEnrolledDeviceError,
} from "./physical-enrollment.js";
export { DeviceProvisioner } from "./device-provisioner.js";
export {
  exactRequirement,
  isSettled,
  type LeaseProgress,
  type LeaseRequestRecord,
  mayBeGranted,
  sameSpec,
  specMode,
  type LeaseTiming,
  type TargetResolution,
  type WaitingDemand,
} from "./domain.js";
export { classCandidates } from "./catalog-match.js";
export { ComponentBeingRemovedError } from "./component-installer.js";
export { type AcquisitionMaintenance } from "./nuke-service.js";
export { ManagedDeviceLifecycle, type ReadyDeviceHandoff } from "./managed-device-lifecycle.js";
export { type ReleasedLease } from "./registry.js";
export { stableError } from "./stable-error.js";
export {
  type LeaseRequestLimits,
  type LeaseRequestOutcome,
  type LeaseRequestStore,
  type NewLeaseRequest,
  newLeaseRequestId,
  newLeaseRequestRecord,
  retainedLeaseRequests,
  withNewLeaseRequest,
  withSettledLeaseRequest,
} from "./lease-request-store.js";
export {
  selectIdleRunningVictim,
  selectManagedVictim,
  type IdleVictimScope,
} from "./idle-order.js";
export { ReclaimCoordinator } from "./reclaim-coordinator.js";
export { createUsageReader, type UsageReader } from "./usage/index.js";
