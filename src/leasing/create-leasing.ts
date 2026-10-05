import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import {
  type ComponentInstaller,
  type Config,
  type Core,
  type DeviceMode,
  type DeviceRequest,
  type DeviceSpec,
  type LeaseGrant,
  type LeaseRecord,
  type LeaseRequestFailure,
  type ModelPreferences,
  type Platform,
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
  QueueControl,
} from "./lease-ports.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { LeaseRequestBook, type WaitingRequest } from "./lease-request-book.js";
import { LeaseStartup } from "./lease-startup.js";
import { type LeaseRequestOptions, WaitQueue } from "./wait-queue.js";

export interface LeasingOptions {
  readonly clock: Clock;
  /**
   * The daemon's one `ComponentInstaller`, built and closed by the composition root. Only the
   * lease path installs through it (safety rule 4).
   */
  readonly components: Pick<ComponentInstaller, "claimProvision" | "install">;
  readonly config: Config;
  /** Device management, built first; `createLeasing` fills its ports through `core.connect`. */
  readonly core: Core;
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  /**
   * Where work leasing finishes off its callers' paths reports its failures. A backgrounded
   * reclaim has no caller left to reject to, so without this its only trace is the device's own
   * registry state.
   */
  readonly logger?: Logger;
  /**
   * Turns the error a lease request failed with into the code and message stored for it. The
   * daemon passes its contract error classifier; leasing never reads the code. Omitted, every
   * failure is stored as `INTERNAL` with its own message.
   */
  readonly describeFailure?: (error: unknown) => LeaseRequestFailure;
  /**
   * The worker's default device mode per platform, built from config by the composition root
   * (ADR 0007 §2). Omitted, or silent on a platform, means `"full"`.
   */
  readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>>;
  /**
   * ADR 0015 §4: the model names to try for each class, per platform, operator's list first.
   * Absent means none, so the catalog names no class default.
   */
  readonly modelPreferences?: ModelPreferences;
  /**
   * Whether the leased-device health monitor is wired. Built here but deliberately not started:
   * the daemon arms it only once startup convergence has finished, so no health probe shells out
   * while convergence is still doing so itself. See `DaemonServer#start`. Default: wired.
   */
  readonly healthMonitor?: boolean;
}

/** What the daemon's request handlers and status reporting use leasing through. */
export interface Leasing extends LeaseCommands, QueueControl, DeviceModeReader {
  /** Every lease request, stored in the registry; read by the HTTP request resource too. */
  readonly requests: LeaseRequestBook<LeaseGrant>;
  /**
   * Present when `createLeasing` wired the monitor. Not started; the daemon arms it after
   * startup convergence.
   */
  readonly healthMonitor: LeaseHealthMonitor | undefined;
  /** Administrative lease expiry used by doctor reconciliation. */
  expire(leaseId: string): Promise<void>;
  /**
   * The lease half of startup, before core's `converge`: settles the requests a restart left
   * open and restores every lease's expiry timer.
   */
  startup(): Promise<void>;
  /** The queue's depth as a fact on the bus, once startup is done: every run begins with one. */
  announceQueueDepth(): void;
  /**
   * Awaits the reclaims release left running in the background, so a graceful shutdown hands
   * back the same settled pool an inline reclaim used to. Runs before `dispose`: a reclaim that
   * settles into a purge failure arms a quarantine retry timer, and cancelling those first would
   * strand it armed.
   */
  settle(): Promise<void>;
  /**
   * Cancels every timer leasing armed, so the process can actually exit. A lease's TTL is a
   * `setTimeout` that outlives the decision to shut down, so without this a daemon with an
   * outstanding lease keeps running long after `daemon stop` -- up to that lease's whole TTL.
   *
   * Cancelling expires nothing early and loses nothing, and under ADR 0004 releases nothing
   * either: `ttlDeadline` is persisted with the lease, and `LeaseExpiryScheduler.restore`
   * re-arms it on the next start. That is exactly what makes a lease survive a daemon restart
   * intact, and a lease whose deadline passed while no daemon was running expire as soon as
   * one is there to expire it.
   */
  dispose(): void;
  /** Every request waiting for a device on this host, for `list.get` and `status.get`. */
  waitingRequests(): readonly WaitingRequest[];
}

/**
 * Composition root for the lease subsystem, built on top of `core` (ADR 0018 §2). Wires leasing's
 * parts together, then hands core the ports it declared through `core.connect`.
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
    onDepthChange: (depth) => options.eventBus.emit("queue.changed", { depth }, "wait-queue"),
    onTimeout: (waiter) => {
      options.eventBus.emit(
        "lease.rejected",
        {
          requestId: waiter.id,
          requester: waiter.options.requesterId,
          requestSpec: waiter.request,
          reason: "timeout",
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
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    registry,
    requests,
  });
  const releaseCoordinator: LeaseReleaseCoordinator = new LeaseReleaseCoordinator({
    claims: core.claims,
    decisions,
    lifecycle: leases,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    notifyAvailability: () => acquisition.kick(),
    registry,
    warmPool: core.warmPool,
  });
  const startup = new LeaseStartup({
    decisions,
    eventBus: options.eventBus,
    registry,
    timers: leases,
  });
  const healthMonitor =
    options.healthMonitor === false
      ? undefined
      : new LeaseHealthMonitor({
          clock: options.clock,
          config: options.config,
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

  core.connect({
    leaseMaintenance: { acquisition, leases: releaseCoordinator },
    notifyAvailability: () => acquisition.kick(),
    queueHeadDemand: () => {
      const spec = acquisition.queueHeadSpec;
      return spec === undefined ? undefined : { spec };
    },
  });

  return {
    requests,
    healthMonitor,
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
    startup: async () => startup.run(),
    announceQueueDepth: () => {
      options.eventBus.emit("queue.changed", { depth: queue.depth }, "wait-queue");
    },
    settle: async () => releaseCoordinator.settleBackgroundReclaims(),
    dispose: () => {
      expiry.dispose();
    },
    get queueDepth(): number {
      return acquisition.queueDepth;
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
