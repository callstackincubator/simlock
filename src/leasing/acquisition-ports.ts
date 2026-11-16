import { type EventBus } from "../bus/index.js";
import {
  type BaselineService,
  type CatalogReader,
  type ComponentInstaller,
  type Core,
  type DeviceMode,
  type DeviceOperationClaims,
  type DeviceProvisioner,
  type DeviceRecord,
  type DriverCatalog,
  type LeaseGrant,
  type LeaseRecord,
  type ManagedDeviceLifecycle,
  type MaxPerRequester,
  type ModelPreferences,
  type Platform,
  type SerializedDecision,
  type VirtualDevice,
} from "../core/index.js";
import { type IdGenerator, type Logger } from "../ports/index.js";
import { type AcquisitionPlanner } from "./acquisition-planner.js";
import { type LeaseLifecycle } from "./lease-lifecycle.js";
import { type LeaseRequestBook } from "./lease-request-book.js";
import { type WaitQueue } from "./wait-queue.js";

export interface LeaseAcquisitionRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
  endedLeaseId(leaseId: string): number | undefined;
}

export type AcquisitionClaims = Pick<DeviceOperationClaims, "isActive">;
export type AcquisitionQuarantine = Pick<Core["quarantine"], "enterFromStalledTransition">;
export type AcquisitionDecision = Pick<SerializedDecision, "run">;
export type AcquisitionDrivers = Pick<DriverCatalog, "get">;
export type AcquisitionPlannerPort = Pick<AcquisitionPlanner, "plan" | "planPhysical">;
export type AcquisitionQueue = Pick<
  WaitQueue,
  | "create"
  | "cancelAll"
  | "depth"
  | "enqueue"
  | "findPendingWaiter"
  | "pendingPlatforms"
  | "head"
  | "isQueued"
  | "markNew"
  | "markProcessing"
  | "notifyProgress"
  | "pending"
  | "physicalDepth"
  | "reject"
  | "resolve"
>;

export interface LeaseAcquisitionCoordinatorOptions {
  readonly baselines: Pick<BaselineService, "current">;
  readonly catalog: Pick<CatalogReader, "listCatalog">;
  readonly claims: AcquisitionClaims;
  readonly components: Pick<ComponentInstaller, "install">;
  readonly decisions: AcquisitionDecision;
  readonly defaultModes: Readonly<Partial<Record<Platform, DeviceMode>>>;
  readonly drivers: AcquisitionDrivers;
  readonly eventBus: Pick<EventBus, "emit">;
  /** Mints a request's id before admission checks, so a request refused there still has one. */
  readonly idGenerator: IdGenerator;
  readonly leases: Pick<LeaseLifecycle, "grant">;
  readonly lifecycle: Pick<
    ManagedDeviceLifecycle,
    "bootForLease" | "destroy" | "dispose" | "rebootForLease" | "shutdown"
  >;
  /**
   * The model names to try for each class, per platform, operator's list first (ADR 0015 §4),
   * built at the composition root. This coordinator holds no model name of its own.
   */
  readonly modelPreferences: ModelPreferences;
  readonly planner: AcquisitionPlannerPort;
  readonly provisioner: Pick<DeviceProvisioner, "provision">;
  readonly queue: AcquisitionQueue;
  readonly quarantine: AcquisitionQuarantine;
  readonly registry: LeaseAcquisitionRegistry;
  readonly logger?: Logger;
  readonly requests: Pick<LeaseRequestBook<LeaseGrant>, "admit" | "holdsLeaseId" | "replay">;
  readonly maxPerRequester?: MaxPerRequester;
}
