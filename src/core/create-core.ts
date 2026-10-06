import type { EventBus } from "../bus/index.js";
import type { Clock, Logger, SystemStats } from "../ports/index.js";
import {
  buildCapacityFigures,
  CapacityCoordinator,
  capacityDevices,
  CapacityObserver,
  createCapacityStrategy,
} from "./capacity/index.js";
import { CleanupExecutor, type CleanupActionExecutor } from "./cleanup-executor.js";
import type { ComponentInstaller } from "./component-installer.js";
import type { Config } from "./config.js";
import type {
  CapacityReader,
  CatalogReader,
  LeaseExpirer,
  PassthroughResolver,
} from "./core-ports.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import { Doctor } from "./doctor.js";
import type { TargetResolution, WaitingDemand } from "./domain.js";
import type { DeviceRequest, Driver, DriverRejection, PrerequisiteCheck } from "./driver.js";
import { DriverCatalog, type ModelPreferences } from "./driver-catalog.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { type AcquisitionMaintenance, type LeaseMaintenance, NukeService } from "./nuke-service.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { ReclaimCoordinator } from "./reclaim-coordinator.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import { WarmPool } from "./warm-pool/index.js";

interface CoreOptions {
  readonly clock: Clock;
  /**
   * The daemon's one `ComponentInstaller`, built and closed by the composition root. Warm-pool
   * provisioning and startup convergence never install through it (safety rule 4); every device
   * provisioned is claimed through it, so none is created on a component being removed (ADR 0010
   * §8).
   */
  readonly components: Pick<ComponentInstaller, "claimProvision" | "install">;
  readonly config: Config;
  /**
   * The one decision gate every registry write runs inside. Passed in rather than built here
   * because `components` writes the registry too and must share it.
   */
  readonly decisions: SerializedDecision;
  readonly drivers: readonly Driver[];
  /** Drivers that refused to start, reported by `doctor` on every run. */
  readonly driverRejections?: readonly DriverRejection[] | undefined;
  readonly eventBus: EventBus;
  /**
   * Where work core finishes off its callers' paths reports its failures. A backgrounded
   * reclaim has no caller left to reject to, so without this its only trace is the device's own
   * registry state.
   */
  readonly logger?: Logger | undefined;
  /** ADR 0015 §4: the model names to try for each class, per platform, operator's list first. */
  readonly modelPreferences?: ModelPreferences | undefined;
  /** The checks `doctor` runs per platform this host could run. None if omitted. */
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[] | undefined;
  readonly registry: Registry;
  readonly systemStats: SystemStats;
}

/**
 * What core needs from leasing and cannot import (ADR 0018 §2). Leasing implements each one and
 * the composition root hands them over through `Core#connect`.
 */
export interface CorePorts {
  /**
   * The fences an operator reset puts around acquisition and around release, and the release of
   * every lease it runs between them (`NukeService`).
   */
  readonly leaseMaintenance: {
    readonly acquisition: AcquisitionMaintenance;
    readonly leases: LeaseMaintenance;
  };
  /** Administrative lease expiry, which doctor reconciliation uses on a lease that lapsed. */
  readonly leaseExpirer: LeaseExpirer;
  /**
   * What the warm pool reads of acquisition: the requests with no device yet, and whether an
   * operator reset holds acquisition closed (the pool then leaves every device alone).
   */
  readonly warmPoolDemand: {
    readonly maintenanceActive: boolean;
    waitingDemand(): readonly WaitingDemand[];
    /** A target as a request, resolved with downloads off: the spec, or why there is none. */
    resolve(request: DeviceRequest): Promise<TargetResolution>;
  };
  /** Tells acquisition a device came back, so a waiting request is tried again. */
  readonly notifyAvailability: () => void;
}

/** A core service reached a port that `Core#connect` has not been given yet. */
class CorePortMissingError extends Error {
  constructor(readonly port: keyof CorePorts) {
    super(`A core service was called before connect() supplied the "${port}" port`);
    this.name = "CorePortMissingError";
  }
}

/** Device management, built and ready except for the ports `connect` fills. */
export interface Core {
  readonly capacity: CapacityCoordinator;
  /** Read-only capacity view for status, and for the daemon's status reporting. */
  readonly capacityReader: CapacityReader;
  /** The device catalog and the passthrough resolver, both answered by the driver catalog. */
  readonly catalog: CatalogReader & PassthroughResolver;
  readonly claims: DeviceOperationClaims;
  /**
   * Read-only claim view for `Doctor`, which must not read a device a service is actively
   * operating on as a stalled transition. Exposed as a reader, not the claims themselves, so
   * a consumer handed only this view cannot take or release a claim. (`claims` above is the
   * full surface; leasing takes and releases through it.)
   */
  readonly claimReader: Pick<DeviceOperationClaims, "isClaimed">;
  readonly cleanup: CleanupActionExecutor;
  readonly decisions: SerializedDecision;
  readonly deviceLifecycle: ManagedDeviceLifecycle;
  readonly doctor: Doctor;
  readonly drivers: DriverCatalog;
  readonly nuke: NukeService;
  readonly provisioner: DeviceProvisioner;
  readonly quarantine: QuarantineCoordinator;
  readonly reclaim: ReclaimCoordinator;
  readonly registry: Registry;
  /** Supplies the ports leasing implements. Call it once, before any request is admitted. */
  connect(ports: CorePorts): void;
  /**
   * The device steps of startup: quarantine restore, interrupted reclaims, spent devices; then it
   * starts the capacity observer and the warm pool, so the facts convergence commits trigger no
   * pass and the first one follows `daemon.started`, where a lowered `maxRunning` is converged.
   */
  converge(): Promise<void>;
  /**
   * Runs a warm pool pass now. Leasing calls it once a backgrounded reclaim has given up its
   * claim: `device.reclaimed` fires while that claim is still held, so the pass it triggers sees
   * the device as busy, and this is the first moment the pool can act on it.
   */
  passWarmPool(): Promise<void>;
  /** The devices the idle shutdown timer leaves alone: those a warm target keeps. */
  targetedDevices(): Promise<ReadonlySet<string>>;
  /** Awaits the warm pool's running pass, so a test or a reset sees a settled pool. */
  settle(): Promise<void>;
  /**
   * A graceful stop: the warm pool starts nothing new and finishes what is in flight, so the
   * daemon exits on a settled pool.
   */
  drain(): Promise<void>;
  /**
   * The first step of a graceful stop: closes the warm pool to new work before leasing settles,
   * so a reclaim that commits meanwhile cannot start a creation `drain` would then wait for.
   */
  closeWarmPool(): void;
  /** Cancels the timers core armed, so the process can exit. */
  dispose(): void;
}

/** Composition root for device management: the registry's services, with no lease in them. */
export function createCore(options: CoreOptions): Core {
  const { decisions, registry } = options;
  let ports: CorePorts | undefined;
  const port = <Name extends keyof CorePorts>(name: Name): CorePorts[Name] => {
    if (ports === undefined) throw new CorePortMissingError(name);
    return ports[name];
  };
  const notifyAvailability = (): void => port("notifyAvailability")();
  const leaseMaintenance = {
    acquisition: {
      beginMaintenance: () => port("leaseMaintenance").acquisition.beginMaintenance(),
      endMaintenance: () => port("leaseMaintenance").acquisition.endMaintenance(),
    },
    leases: {
      beginMaintenance: () => port("leaseMaintenance").leases.beginMaintenance(),
      endMaintenance: () => port("leaseMaintenance").leases.endMaintenance(),
      releaseAllDuringMaintenance: (reason: "killed") =>
        port("leaseMaintenance").leases.releaseAllDuringMaintenance(reason),
    },
  };

  const capacity = new CapacityCoordinator(
    createCapacityStrategy(options.config.capacity, options.systemStats),
    () => capacityObserver.changed(),
  );
  const devices = () => capacityDevices(registry.snapshot.devices);
  const capacityReader: CapacityReader = {
    get runningCapacity() {
      return capacity.runningCapacity(devices());
    },
    deviceLimit: (platform) => capacity.deviceLimit(platform),
    atRamBudget: (platform) => capacity.atRamBudget(platform, devices()),
    get ramBudget() {
      return capacity.ramBudget(devices());
    },
  };
  const capacityObserver: CapacityObserver = new CapacityObserver({
    eventBus: options.eventBus,
    figures: () => buildCapacityFigures(registry.snapshot.devices, capacityReader),
  });
  registry.onCommit(() => capacityObserver.changed());
  const claims = new DeviceOperationClaims();
  const drivers = new DriverCatalog(options.drivers, {
    logger: options.logger,
    preferences: options.modelPreferences,
  });
  const deviceLifecycle = new ManagedDeviceLifecycle(
    drivers,
    registry,
    decisions,
    claims,
    options.clock,
  );
  const provisioner = new DeviceProvisioner({
    catalog: drivers,
    claims,
    clock: options.clock,
    components: options.components,
    decisions,
    lifecycle: deviceLifecycle,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
  });
  const quarantine = new QuarantineCoordinator({
    clock: options.clock,
    config: options.config.warmPool.quarantine,
    decisions,
    drivers,
    eventBus: options.eventBus,
    notifyAvailability,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
  });
  const reclaim = new ReclaimCoordinator({
    clock: options.clock,
    decisions,
    drivers,
    eventBus: options.eventBus,
    notifyAvailability,
    quarantine,
    registry,
  });
  const cleanup = new CleanupExecutor({
    eventBus: options.eventBus,
    lifecycle: deviceLifecycle,
    notifyAvailability,
    registry,
  });
  const warmPool = new WarmPool({
    acquisition: {
      kick: notifyAvailability,
      get maintenanceActive() {
        return port("warmPoolDemand").maintenanceActive;
      },
      resolve: (request) => port("warmPoolDemand").resolve(request),
      waitingDemand: () => port("warmPoolDemand").waitingDemand(),
    },
    capacity,
    claims,
    clock: options.clock,
    config: options.config.warmPool,
    decisions,
    eventBus: options.eventBus,
    idle: options.config.idle,
    lifecycle: deviceLifecycle,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    provisioner,
    registry,
  });
  const nuke = new NukeService({
    acquisition: {
      // Closing acquisition first makes the pool skip every new action; then a boot or shutdown it
      // already has in flight is waited for, so the reset sees a settled pool.
      beginMaintenance: async () => {
        await leaseMaintenance.acquisition.beginMaintenance();
        await warmPool.settle();
      },
      endMaintenance: async () => leaseMaintenance.acquisition.endMaintenance(),
    },
    devices: deviceLifecycle,
    leases: leaseMaintenance.leases,
    registry,
  });
  const doctor = new Doctor({
    // Without this, a backgrounded reclaim -- which holds its device in `reclaiming` for a full
    // erase, and is now how every release purges -- reads as a stalled transition.
    claims,
    clock: options.clock,
    config: options.config,
    drivers: options.drivers,
    driverRejections: options.driverRejections ?? [],
    eventBus: options.eventBus,
    leaseExpirer: { expire: async (leaseId) => port("leaseExpirer").expire(leaseId) },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    prerequisiteChecks: options.prerequisiteChecks ?? [],
    quarantine,
    registry,
  });
  const startup = new StartupConverger({
    claims,
    decisions,
    drivers,
    interruptedReclaimRecovery: {
      recoverInterruptedReclaim: async (device) => {
        await reclaim.recoverInterrupted(device.id);
      },
    },
    quarantineRestore: { restore: () => quarantine.restore() },
    registry,
    spentDeviceDeletion: {
      // A failed delete must not stop the daemon from starting: the device stays `shutdown`
      // and ungrantable, and the next start (or the idle delete rule) tries again.
      deleteSpent: async (device) => {
        try {
          await reclaim.deleteSpent(device.id);
        } catch (error: unknown) {
          options.logger?.error("startup delete of a spent device failed", {
            deviceId: device.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  });

  return {
    capacity,
    capacityReader,
    catalog: drivers,
    claims,
    claimReader: claims,
    cleanup,
    decisions,
    deviceLifecycle,
    doctor,
    drivers,
    nuke,
    provisioner,
    quarantine,
    reclaim,
    registry,
    connect(supplied) {
      ports = supplied;
    },
    async converge() {
      await startup.converge();
      warmPool.start();
      // Every run begins with a step in the figures: what they are now.
      capacityObserver.start();
    },
    async passWarmPool() {
      await warmPool.pass();
    },
    async targetedDevices() {
      return warmPool.targeted();
    },
    closeWarmPool() {
      warmPool.close();
    },
    async drain() {
      await warmPool.drain();
    },
    async settle() {
      await warmPool.settle();
    },
    dispose() {
      warmPool.dispose();
      quarantine.dispose();
    },
  };
}
