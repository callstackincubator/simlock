import type { EventBus } from "../bus/index.js";
import type { Clock, Logger, SystemStats } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
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
  WarmPoolReader,
  CatalogReader,
  LeaseExpirer,
  PassthroughResolver,
} from "./core-ports.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import { Doctor, type OptionalModuleFinding } from "./doctor.js";
import type { DeviceMode, Platform, TargetResolution, WaitingDemand } from "./domain.js";
import type { DeviceRequest, Driver, DriverRejection, PrerequisiteCheck } from "./driver.js";
import { DriverCatalog, type ModelPreferences } from "./driver-catalog.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { type AcquisitionMaintenance, type LeaseMaintenance, NukeService } from "./nuke-service.js";
import { PhysicalEnrollment } from "./physical-enrollment.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { ReclaimCoordinator } from "./reclaim-coordinator.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import { readStartup, type StartupRead } from "./startup-read.js";
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
  readonly optionalModules?: (() => readonly OptionalModuleFinding[]) | undefined;
  /** The checks `doctor` runs per platform this host could run. None if omitted. */
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[] | undefined;
  readonly registry: Registry;
  readonly state: StateDatabase;
  readonly systemStats: SystemStats;
}

export interface CorePorts {
  readonly leaseMaintenance: {
    readonly acquisition: AcquisitionMaintenance;
    readonly leases: LeaseMaintenance;
  };
  readonly leaseExpirer: LeaseExpirer;
  readonly warmPoolDemand: {
    readonly maintenanceActive: boolean;
    waitingDemand(): readonly WaitingDemand[];
    defaultMode(platform: Platform): DeviceMode;
    resolve(request: DeviceRequest): Promise<TargetResolution>;
  };
  readonly notifyAvailability: () => void;
  readonly physicalDeviceReady?: (deviceId: string) => void;
}

class CorePortMissingError extends Error {
  constructor(readonly port: keyof CorePorts) {
    super(`A core service was called before connect() supplied the "${port}" port`);
    this.name = "CorePortMissingError";
  }
}

export interface Core {
  readonly capacity: CapacityCoordinator;
  readonly capacityReader: CapacityReader;
  readonly warmPoolReader: WarmPoolReader;
  readonly catalog: CatalogReader & PassthroughResolver;
  readonly claims: DeviceOperationClaims;
  readonly claimReader: Pick<DeviceOperationClaims, "isClaimed">;
  readonly cleanup: CleanupActionExecutor;
  readonly decisions: SerializedDecision;
  readonly deviceLifecycle: ManagedDeviceLifecycle;
  readonly doctor: Doctor;
  readonly drivers: DriverCatalog;
  readonly enrollment: PhysicalEnrollment;
  readonly nuke: NukeService;
  readonly provisioner: DeviceProvisioner;
  readonly quarantine: QuarantineCoordinator;
  readonly reclaim: ReclaimCoordinator;
  readonly registry: Registry;
  /** Supplies the ports leasing implements. Call it once, before any request is admitted. */
  connect(ports: CorePorts): void;
  readStartup(): Promise<StartupRead>;
  converge(read: StartupRead): Promise<void>;
  /**
   * Runs a warm pool pass now. Leasing calls it once a backgrounded reclaim has given up its
   * claim: `device.reclaimed` fires while that claim is still held, so the pass it triggers sees
   * the device as busy, and this is the first moment the pool can act on it.
   */
  passWarmPool(): Promise<void>;
  /** The devices the idle shutdown timer leaves alone: those a warm target keeps. */
  targetedDevices(): Promise<ReadonlySet<string>>;
  settle(): Promise<void>;
  drain(): Promise<void>;
  /**
   * why: closes the warm pool before leasing settles, so a reclaim
   * that commits meanwhile cannot start a creation `drain` would then wait for.
   */
  closeWarmPool(): void;
  dispose(): void;
}

export function createCore(options: CoreOptions): Core {
  const { decisions, registry } = options;
  let ports: CorePorts | undefined;
  const port = <Name extends keyof CorePorts>(name: Name): CorePorts[Name] => {
    if (ports === undefined) throw new CorePortMissingError(name);
    return ports[name];
  };
  const notifyAvailability = (): void => port("notifyAvailability")();
  const physicalDeviceReady = (deviceId: string): void => ports?.physicalDeviceReady?.(deviceId);
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
  const devices = () => capacityDevices(registry.snapshot.virtualDevices);
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
    figures: () => buildCapacityFigures(registry.snapshot.virtualDevices, capacityReader),
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
    claims,
    clock: options.clock,
    config: options.config.warmPool.quarantine,
    decisions,
    drivers,
    eventBus: options.eventBus,
    notifyAvailability,
    physicalDeviceReady,
    probeIntervalMs: options.config.health.probeIntervalMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
  });
  const reclaim = new ReclaimCoordinator({
    claims,
    clock: options.clock,
    decisions,
    drivers,
    eventBus: options.eventBus,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    notifyAvailability,
    physicalDeviceReady,
    quarantine,
    registry,
  });
  const enrollment = new PhysicalEnrollment({
    claims,
    decisions,
    drivers,
    physicalDeviceReady,
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
      defaultMode: (platform) => port("warmPoolDemand").defaultMode(platform),
    },
    capacity,
    catalog: drivers,
    claims,
    clock: options.clock,
    config: options.config.warmPool,
    decisions,
    eventBus: options.eventBus,
    hasDriver: (platform) => drivers.select(platform).length > 0,
    idle: options.config.idle,
    lifecycle: deviceLifecycle,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    provisioner,
    registry,
    state: options.state,
  });
  const nuke = new NukeService({
    acquisition: {
      // Closing acquisition first makes the pool skip every new action; then a boot or shutdown it
      // already has in flight is waited for, so the reset sees a settled pool. A startup wipe still
      // running is waited for first: its commit can start a pool pass, and the device it holds in
      // `reclaiming` is one the reset would skip.
      beginMaintenance: async () => {
        await leaseMaintenance.acquisition.beginMaintenance();
        await reclaim.settle();
        await warmPool.settle();
      },
      endMaintenance: async () => leaseMaintenance.acquisition.endMaintenance(),
    },
    devices: deviceLifecycle,
    leases: leaseMaintenance.leases,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
    warmPool: { forget: () => warmPool.forget() },
  });
  const doctor = new Doctor({
    // Without this, a backgrounded reclaim -- which holds its device in `reclaiming` for a full
    // erase, and is now how every release purges -- reads as a stalled transition.
    claims,
    clock: options.clock,
    config: options.config,
    decisions,
    drivers: options.drivers,
    driverRejections: options.driverRejections ?? [],
    eventBus: options.eventBus,
    leaseExpirer: { expire: async (leaseId) => port("leaseExpirer").expire(leaseId) },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.optionalModules === undefined ? {} : { optionalModules: options.optionalModules }),
    prerequisiteChecks: options.prerequisiteChecks ?? [],
    quarantine,
    registry,
    warmPool: {
      figures: () => warmPool.figures(),
      runningCapacity: () => capacityReader.runningCapacity,
    },
  });
  const startup = new StartupConverger({
    claims,
    decisions,
    interruptedReclaimRecovery: {
      recoverInterruptedReclaim: async (device) => {
        await reclaim.recoverInterrupted(device.id);
      },
    },
    quarantineRestore: { restore: (include) => quarantine.restore(include) },
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
    warmPoolReader: warmPool,
    catalog: drivers,
    claims,
    claimReader: claims,
    cleanup,
    decisions,
    deviceLifecycle,
    doctor,
    drivers,
    enrollment,
    nuke,
    provisioner,
    quarantine,
    reclaim,
    registry,
    connect(supplied) {
      ports = supplied;
    },
    readStartup: () =>
      readStartup({ clock: options.clock, drivers: options.drivers, logger: options.logger }),
    async converge(read) {
      await startup.converge(read);
      warmPool.start();
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
      // The wipe's commit can start a pool pass, so the wipes are awaited first.
      await reclaim.settle();
      await warmPool.settle();
    },
    dispose() {
      warmPool.dispose();
      quarantine.dispose();
    },
  };
}
