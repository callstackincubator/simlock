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
import type { CapacityReader, CatalogReader, PassthroughResolver } from "./core-ports.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import type { DeviceSpec } from "./domain.js";
import type { Driver } from "./driver.js";
import { DriverCatalog, type ModelPreferences } from "./driver-catalog.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { type AcquisitionMaintenance, type LeaseMaintenance, NukeService } from "./nuke-service.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import { WarmPoolCoordinator } from "./warm-pool-coordinator.js";

export interface CoreOptions {
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
  readonly eventBus: EventBus;
  /**
   * Where work core finishes off its callers' paths reports its failures. A backgrounded
   * reclaim has no caller left to reject to, so without this its only trace is the device's own
   * registry state.
   */
  readonly logger?: Logger;
  /** ADR 0015 §4: the model names to try for each class, per platform, operator's list first. */
  readonly modelPreferences?: ModelPreferences;
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
  /** Tells acquisition a device came back, so a waiting request is tried again. */
  readonly notifyAvailability: () => void;
  /** The spec the queue's head waits for, when one waits; the warm pool keeps a device for it. */
  readonly queueHeadDemand: () => { readonly spec: DeviceSpec } | undefined;
}

/** A core service reached a port that `Core#connect` has not been given yet. */
export class CorePortMissingError extends Error {
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
   * nothing outside core can take or release a claim.
   */
  readonly claimReader: Pick<DeviceOperationClaims, "isClaimed">;
  readonly cleanup: CleanupActionExecutor;
  readonly decisions: SerializedDecision;
  readonly deviceLifecycle: ManagedDeviceLifecycle;
  readonly drivers: DriverCatalog;
  readonly nuke: NukeService;
  readonly provisioner: DeviceProvisioner;
  readonly quarantine: QuarantineCoordinator;
  readonly registry: Registry;
  readonly warmPool: WarmPoolCoordinator;
  /** Supplies the ports leasing implements. Call it once, before any request is admitted. */
  connect(ports: CorePorts): void;
  /** The device steps of startup: quarantine restore, interrupted reclaims, spent devices, excess. */
  converge(): Promise<void>;
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
  const warmPool = new WarmPoolCoordinator({
    capacity,
    clock: options.clock,
    decisions,
    drivers,
    eventBus: options.eventBus,
    notifyAvailability,
    quarantine,
    queueHeadDemand: () => port("queueHeadDemand")(),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
  });
  const cleanup = new CleanupExecutor({
    eventBus: options.eventBus,
    lifecycle: deviceLifecycle,
    notifyAvailability,
    registry,
  });
  const nuke = new NukeService({
    acquisition: leaseMaintenance.acquisition,
    devices: deviceLifecycle,
    leases: leaseMaintenance.leases,
    registry,
  });
  const startup = new StartupConverger({
    capacity: capacityReader,
    claims,
    cleanup,
    decisions,
    drivers,
    interruptedReclaimRecovery: {
      recoverInterruptedReclaim: async (device) => {
        await warmPool.recoverInterrupted(device.id);
      },
    },
    quarantineRestore: { restore: () => quarantine.restore() },
    registry,
    spentDeviceDeletion: {
      // A failed delete must not stop the daemon from starting: the device stays `shutdown`
      // and ungrantable, and the next start (or the idle delete rule) tries again.
      deleteSpent: async (device) => {
        try {
          await warmPool.deleteSpent(device.id);
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
    drivers,
    nuke,
    provisioner,
    quarantine,
    registry,
    warmPool,
    connect(supplied) {
      ports = supplied;
    },
    async converge() {
      await startup.converge();
      // Every run begins with a step in the figures: what they are now.
      capacityObserver.start();
    },
    dispose() {
      quarantine.dispose();
    },
  };
}
