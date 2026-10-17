import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import {
  type ComponentInstaller,
  type Config,
  type Core,
  type CorePorts,
  type DeviceMode,
  type DeviceRequest,
  type DeviceSpec,
  type LeaseGrant,
  type LeaseRecord,
  type LeaseRequestFailure,
  type ModelPreferences,
  type Platform,
  type StartupRead,
} from "../core/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import { LeaseAcquisitionCoordinator } from "./lease-acquisition-coordinator.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseHealthMonitor } from "./lease-health-monitor.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import type {
  ClientReleaseReason,
  DeviceModeReader,
  LeaseCommands,
  LeaseEndParticipant,
  QueueControl,
} from "./lease-ports.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { LeaseRequestBook, type WaitingRequest } from "./lease-request-book.js";
import { LeaseReconciler } from "./lease-reconciler.js";
import { emitLeaseRefusal } from "./lease-refusal.js";
import { LeaseStartup } from "./lease-startup.js";
import { PhysicalDeviceWatcher } from "./physical-device-watcher.js";
import { type LeaseRequestOptions, WaitQueue } from "./wait-queue.js";

export interface LeasingOptions {
  readonly clock: Clock;
  readonly components: Pick<ComponentInstaller, "claimProvision" | "install">;
  readonly config: Config;
  readonly core: Core;
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  /**
   * why: a backgrounded reclaim has no caller left to reject to; without this its only trace is the
   * device's own registry state.
   */
  readonly logger?: Logger | undefined;
  readonly describeFailure?: ((error: unknown) => LeaseRequestFailure) | undefined;
  /**
   * The worker's default device mode per platform, built from config by the composition root
   * (ADR 0007 §2). Omitted, or silent on a platform, means `"full"`.
   */
  readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>> | undefined;
  readonly modelPreferences?: ModelPreferences | undefined;
  /** why: not started on build: a health probe would shell out while startup convergence does. */
  readonly healthMonitor?: boolean | undefined;
  readonly leaseEndParticipants?: readonly LeaseEndParticipant[] | undefined;
}

export interface Leasing extends LeaseCommands, QueueControl, DeviceModeReader {
  /**
   * why: building leasing does not connect them, so building one over a core never re-points that core's
   * ports.
   */
  readonly corePorts: CorePorts;
  readonly requests: LeaseRequestBook<LeaseGrant>;
  readonly healthMonitor: LeaseHealthMonitor | undefined;
  /** why: wired whatever `health.enabled` says; the daemon arms it after startup convergence. */
  readonly physicalDeviceWatcher: PhysicalDeviceWatcher;
  expire(leaseId: string): Promise<void>;
  settleRequests(): Promise<void>;
  /** why: runs before core's `converge`, so no device convergence picks a device this is about to release. */
  reconcile(read: StartupRead): Promise<void>;
  announceQueueDepth(): void;
  /**
   * why: runs before `dispose`: a reclaim that settles into a purge failure arms a quarantine retry
   * timer, and cancelling first would strand it armed.
   */
  settle(): Promise<void>;
  /**
   * why: cancelling expires nothing and releases nothing: `ttlDeadline` is persisted and
   * re-armed on the next start. Without this a lease's TTL timer keeps the process alive after
   * `daemon stop`.
   */
  dispose(): void;
  waitingRequests(): readonly WaitingRequest[];
}

/**
 * Composition root for the lease subsystem, built on top of `core` (ADR 0018 §2). Wires leasing's
 * parts together and returns the ports core declared as `corePorts`; the daemon connects them.
 */
export function createLeasing(options: LeasingOptions): Leasing {
  const { core } = options;
  const { decisions, registry } = core;
  const planner = new AcquisitionPlanner(core.capacity, core.claims);
  const expiry = new LeaseExpiryScheduler(
    options.clock,
    async (leaseId, expectedDeadline) => {
      await releaseCoordinator.expire(leaseId, expectedDeadline);
    },
    options.logger,
  );
  const leases = new LeaseLifecycle({
    clock: options.clock,
    eventBus: options.eventBus,
    expiryScheduler: expiry,
    registry,
    ttl: { defaultMs: options.config.lease.defaultTtlMs },
  });
  const queue = new WaitQueue({
    clock: options.clock,
    idGenerator: options.idGenerator,
    onDepthChange: (depth, line) =>
      options.eventBus.emit(
        "queue.changed",
        line === "physical" ? { depth, physical: true } : { depth },
        "wait-queue",
      ),
    onTimeout: (waiter) => {
      emitLeaseRefusal(
        options.eventBus,
        {
          requestId: waiter.id,
          requester: waiter.options.requesterId,
          requestSpec: waiter.request,
          reason: "timeout",
          fleetRequestId: waiter.options.fleetRequestId,
        },
        "wait-queue",
      );
      acquisition.kick();
    },
  });
  const requests = new LeaseRequestBook<LeaseGrant>({
    decisions,
    describeFailure: options.describeFailure ?? describeUnclassifiedFailure,
    store: registry,
  });
  const acquisition: LeaseAcquisitionCoordinator = new LeaseAcquisitionCoordinator({
    catalog: core.drivers,
    claims: core.claims,
    components: options.components,
    decisions,
    defaultModes: options.defaultModes ?? {},
    drivers: core.drivers,
    eventBus: options.eventBus,
    idGenerator: options.idGenerator,
    leases,
    lifecycle: core.deviceLifecycle,
    modelPreferences: options.modelPreferences ?? {},
    planner,
    provisioner: core.provisioner,
    queue,
    quarantine: core.quarantine,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    maxPerRequester: options.config.lease.maxPerRequester,
    registry,
    requests,
  });
  const releaseCoordinator: LeaseReleaseCoordinator = new LeaseReleaseCoordinator({
    claims: core.claims,
    decisions,
    ...(options.leaseEndParticipants === undefined || options.leaseEndParticipants.length === 0
      ? {}
      : {
          leaseEnd: {
            clock: options.clock,
            endWaitMs: options.config.lease.endWaitMs,
            participants: options.leaseEndParticipants,
          },
        }),
    lifecycle: leases,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    // Called once a backgrounded reclaim has given up its claim; the warm pool can act on the
    // device from this moment (see `Core#passWarmPool`).
    notifyAvailability: () => {
      acquisition.kick();
      void core.passWarmPool();
    },
    registry,
    reclaim: core.reclaim,
  });
  const startup = new LeaseStartup({
    decisions,
    eventBus: options.eventBus,
    reconciler: new LeaseReconciler({ clock: options.clock, ender: releaseCoordinator, registry }),
    registry,
    timers: leases,
  });
  const healthMonitor =
    options.healthMonitor === false
      ? undefined
      : new LeaseHealthMonitor({
          clock: options.clock,
          config: options.config,
          decisions,
          drivers: core.drivers,
          eventBus: options.eventBus,
          lifecycle: core.deviceLifecycle,
          registry,
          releaser: {
            releaseDeviceLost: async (leaseId) => {
              await releaseCoordinator.releaseDeviceLost(leaseId);
            },
          },
        });

  const physicalDeviceWatcher = new PhysicalDeviceWatcher({
    claims: core.claims,
    clock: options.clock,
    config: options.config,
    decisions,
    drivers: core.drivers,
    kick: () => acquisition.kick(),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
    releaser: releaseCoordinator,
  });

  return {
    corePorts: {
      leaseExpirer: {
        expire: async (leaseId) => {
          await releaseCoordinator.expire(leaseId);
        },
      },
      leaseMaintenance: { acquisition, leases: releaseCoordinator },
      notifyAvailability: () => acquisition.kick(),
      physicalDeviceReady: (deviceId) => physicalDeviceWatcher.reset(deviceId),
      warmPoolDemand: {
        get maintenanceActive() {
          return acquisition.maintenanceActive;
        },
        resolve: (request) => acquisition.resolve(request),
        waitingDemand: () => acquisition.waitingDemand(),
        defaultMode: (platform) => acquisition.defaultMode(platform),
      },
    },
    requests,
    healthMonitor,
    physicalDeviceWatcher,
    request: async (
      request: DeviceRequest,
      requestOptions: LeaseRequestOptions,
    ): Promise<LeaseGrant> => acquisition.request(request, requestOptions),
    release: async (leaseId: string, reason: ClientReleaseReason) => {
      await releaseCoordinator.release(leaseId, reason);
    },
    releaseAll: async (reason: ClientReleaseReason) => releaseCoordinator.releaseAll(reason),
    renew: async (leaseId: string, ttlMs?: number): Promise<LeaseRecord> =>
      releaseCoordinator.renew(leaseId, ttlMs),
    expire: async (leaseId: string) => {
      await releaseCoordinator.expire(leaseId);
    },
    settleRequests: async () => startup.settleRequests(),
    reconcile: async (read: StartupRead) => {
      await startup.reconcile(read);
      physicalDeviceWatcher.recordInterrupted();
    },
    announceQueueDepth: () => {
      options.eventBus.emit("queue.changed", { depth: queue.depth }, "wait-queue");
    },
    settle: async () => {
      await physicalDeviceWatcher.settle();
      await releaseCoordinator.settleBackgroundReclaims();
    },
    dispose: () => {
      releaseCoordinator.dispose();
      physicalDeviceWatcher.dispose();
      expiry.dispose();
    },
    get queueDepth(): number {
      return acquisition.queueDepth;
    },
    get physicalQueueDepth(): number {
      return acquisition.physicalQueueDepth;
    },
    waitingRequests: () => requests.waiting(queue.places()),
    cancelPending: async (requesterId: string) => acquisition.cancelPending(requesterId),
    pendingRequestOwner: (requesterId: string) => acquisition.pendingRequestOwner(requesterId),
    servesDefaultMode: (spec: DeviceSpec) => acquisition.servesDefaultMode(spec),
  };
}

function describeUnclassifiedFailure(error: unknown): LeaseRequestFailure {
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
