import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, SystemStats, TimerHandle } from "../ports/index.js";
import { canProvision } from "./capacity.js";
import type { Config } from "./config.js";
import type { Proposal } from "./cleanup/types.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord, Platform } from "./domain.js";
import { BootTimeoutError, type DeviceRequest, type Driver, type DriverDevice } from "./driver.js";
import { Registry, type ReleasedLease } from "./registry.js";

export interface LeaseRequestOptions {
  readonly requesterId: string;
  readonly mode: "held" | "detached";
  readonly timeoutMs?: number;
  readonly noWait?: boolean;
  readonly allowDownload?: boolean;
  readonly onProgress?: (progress: LeaseProgress) => void;
}

/** Request-scoped progress for the lease action currently being performed. */
export type LeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "provisioning"; readonly etaMs: number }
  | { readonly stage: "booting"; readonly etaMs: number }
  | { readonly stage: "reclaiming"; readonly etaMs: number };

export interface LeaseTiming {
  readonly estimatedProvisionMs: number;
  readonly estimatedBootMs: number;
  readonly estimatedReclaimMs: number;
  readonly estimatedReadyMs: number;
}

export interface LeaseGrant {
  readonly device: DeviceRecord;
  readonly lease: LeaseRecord;
  readonly timing: LeaseTiming;
}

export interface LeaseEngineOptions {
  readonly clock: Clock;
  readonly config: Config;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  readonly registry: Registry;
  readonly systemStats: SystemStats;
}

export class NoCapacityError extends Error {
  constructor() {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

export class QueueTimeoutError extends Error {
  constructor(readonly requestId: string) {
    super(`Timed out waiting for a device: ${requestId}`);
    this.name = "QueueTimeoutError";
  }
}

export class RequesterAlreadyLeasedError extends Error {
  constructor(readonly requesterId: string) {
    super(`Requester already has a lease or pending request: ${requesterId}`);
    this.name = "RequesterAlreadyLeasedError";
  }
}

export class HeldLeaseRenewalError extends Error {
  constructor(readonly leaseId: string) {
    super(`Held lease cannot be renewed: ${leaseId}`);
    this.name = "HeldLeaseRenewalError";
  }
}

export class NukeCancelledError extends Error {
  constructor() {
    super("Request cancelled by nuke");
    this.name = "NukeCancelledError";
  }
}

export class NoDriverError extends Error {
  constructor(readonly platform: Platform) {
    super(`No driver registered for platform: ${platform}`);
    this.name = "NoDriverError";
  }
}

type WaiterState = "new" | "queued" | "processing" | "granted" | "rejected";

interface Waiter {
  readonly id: string;
  readonly request: DeviceRequest;
  readonly options: LeaseRequestOptions;
  onProgress: ((progress: LeaseProgress) => void) | undefined;
  readonly promise: Promise<LeaseGrant>;
  readonly reject: (error: Error) => void;
  readonly resolve: (grant: LeaseGrant) => void;
  failures: number;
  spec?: DeviceSpec;
  state: WaiterState;
  timer?: TimerHandle;
  timing: LeaseTiming;
}

interface ProvisionAction {
  readonly kind: "provision";
}

interface ReclaimWarmAction {
  readonly kind: "reclaim-warm";
  readonly device: DeviceRecord;
}

interface BootShutdownAction {
  readonly kind: "boot-shutdown";
  readonly device: DeviceRecord;
}

const noTiming: LeaseTiming = {
  estimatedBootMs: 0,
  estimatedProvisionMs: 0,
  estimatedReclaimMs: 0,
  estimatedReadyMs: 0,
};

/**
 * The daemon's serialized leasing transaction coordinator. Driver work is
 * intentionally performed after each decision section has been released.
 */
export class LeaseEngine {
  readonly #drivers = new Map<Platform, Driver>();
  readonly #leaseTimers = new Map<string, TimerHandle>();
  readonly #provisionReservations: Platform[] = [];
  readonly #shutdownReservations = new Set<string>();
  readonly #warmReservations = new Set<string>();
  readonly #cleanupReservations = new Set<string>();
  readonly #queue: Waiter[] = [];
  readonly #requesters = new Set<string>();
  #decisionTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: LeaseEngineOptions) {
    for (const driver of options.drivers) {
      this.#drivers.set(driver.platform, driver);
    }
  }

  async request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    const waiter = this.#newWaiter(request, options);
    try {
      await this.#withDecision(async () => {
        if (this.#requesters.has(options.requesterId)) {
          this.options.eventBus.emit(
            "lease.rejected",
            { requestSpec: request, reason: "already-leased" },
            "lease-engine",
          );
          throw new RequesterAlreadyLeasedError(options.requesterId);
        }

        this.#requesters.add(options.requesterId);
        this.options.eventBus.emit(
          "lease.requested",
          {
            requestSpec: request,
            requester: options.requesterId,
            waitPolicy: options.noWait ? "no-wait" : "wait",
          },
          "lease-engine",
        );
      });
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    const driver = this.#drivers.get(request.platform);
    if (driver === undefined) {
      await this.#withDecision(async () => {
        this.#reject(waiter, new NoDriverError(request.platform), "unresolvable-spec");
      });
      return waiter.promise;
    }

    try {
      waiter.spec = await driver.resolveSpec(request, {
        allowDownload: options.allowDownload ?? false,
      });
    } catch (error: unknown) {
      await this.#withDecision(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return waiter.promise;
    }

    void this.#drive(waiter);
    return waiter.promise;
  }

  async release(leaseId: string, reason: "closed" | "explicit" | "killed"): Promise<void> {
    await this.#release(leaseId, reason);
  }

  /** Releases the daemon's current leases for an explicit operator command. */
  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    const leaseIds = this.options.registry.snapshot.leases.map((lease) => lease.id);
    await Promise.all(leaseIds.map(async (leaseId) => this.release(leaseId, reason)));
    return leaseIds;
  }

  async expire(leaseId: string): Promise<void> {
    await this.#release(leaseId, "expired");
  }

  /** Operator-only reset; targets device records from this registry exclusively. */
  async nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    const releasedLeaseIds = await this.releaseAll("killed");
    await this.#withDecision(async () => {
      while (this.#queue[0] !== undefined) {
        const waiter = this.#queue[0];
        this.#reject(waiter, new NukeCancelledError(), "killed");
      }
    });

    for (const device of this.options.registry.snapshot.devices) {
      if (device.state === "deleted") continue;
      const driver = this.#driverFor(device.spec.platform);
      if (device.state === "ready" || device.state === "warm") {
        await driver.shutdown(toDriverDevice(device));
        await this.#withDecision(async () => {
          const current = this.options.registry.snapshot.devices.find(
            (candidate) => candidate.id === device.id,
          );
          if (current?.state === "ready" || current?.state === "warm") {
            await this.options.registry.transitionDevice(device.id, "shutdown", {
              event: "device.shutdown",
              payload: { deviceId: device.id, initiator: "nuke" },
            });
          }
        });
      }
      if (deleteDevices) {
        const current = this.options.registry.snapshot.devices.find(
          (candidate) => candidate.id === device.id,
        );
        if (current?.state !== "shutdown") continue;
        await driver.destroy(toDriverDevice(current));
        await this.#withDecision(async () => {
          const latest = this.options.registry.snapshot.devices.find(
            (candidate) => candidate.id === device.id,
          );
          if (latest?.state === "shutdown") {
            await this.options.registry.transitionDevice(device.id, "deleted", {
              event: "device.deleted",
              payload: { deviceId: device.id, initiator: "nuke" },
            });
          }
        });
      }
    }
    return { releasedLeaseIds };
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  /** Stops client feedback for a queued request without affecting its lease outcome. */
  async detachQueuedProgress(requesterId: string): Promise<void> {
    await this.#withDecision(async () => {
      const waiter = this.#queue.find((candidate) => candidate.options.requesterId === requesterId);
      if (waiter !== undefined) {
        waiter.onProgress = undefined;
      }
    });
  }

  async renew(leaseId: string, ttlMs: number): Promise<LeaseRecord> {
    return this.#withDecision(async () => {
      const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
      if (current?.mode === "held") {
        throw new HeldLeaseRenewalError(leaseId);
      }
      const deadline = this.options.clock.now() + ttlMs;
      const renewed = await this.options.registry.renewLease(leaseId, deadline);
      this.#cancelLeaseTimer(leaseId);
      this.#armLeaseTimer(renewed);
      this.options.eventBus.emit(
        "lease.renewed",
        { leaseId: renewed.id, newDeadline: renewed.ttlDeadline },
        "lease-engine",
      );
      return renewed;
    });
  }

  /**
   * Runs one cleanup action through the same decision queue as leasing. The
   * reservation prevents a concurrent lease decision from selecting the
   * device while its driver operation is in progress.
   */
  async executeCleanup(proposal: Proposal): Promise<boolean> {
    const action = proposal.action;
    if (action !== "shutdown" && action !== "destroy") {
      return false;
    }

    const device = await this.#withDecision(async () => {
      const candidate = this.options.registry.snapshot.devices.find(
        (current) => current.id === proposal.target,
      );
      if (candidate === undefined || !this.#canExecuteCleanup(candidate, action)) {
        return undefined;
      }
      this.#cleanupReservations.add(candidate.id);
      return candidate;
    });
    if (device === undefined) {
      return false;
    }

    const driver = this.#driverFor(device.spec.platform);
    try {
      if (action === "shutdown") {
        await driver.shutdown(toDriverDevice(device));
      } else {
        await driver.destroy(toDriverDevice(device));
      }
    } catch (error: unknown) {
      await this.#withDecision(async () => {
        this.#cleanupReservations.delete(device.id);
      });
      throw error;
    }

    await this.#withDecision(async () => {
      this.#cleanupReservations.delete(device.id);
      const event =
        action === "shutdown"
          ? {
              event: "device.shutdown" as const,
              payload: { deviceId: device.id, initiator: "cleanup-reaper" },
            }
          : {
              event: "device.deleted" as const,
              payload: { deviceId: device.id, initiator: "cleanup-reaper" },
            };
      await this.options.registry.transitionDevice(
        device.id,
        action === "shutdown" ? "shutdown" : "deleted",
        event,
      );
    });
    this.#wakeQueue();
    return true;
  }

  async #drive(waiter: Waiter): Promise<void> {
    const action = await this.#withDecision(async () => this.#decide(waiter));
    if (action === undefined) {
      return;
    }

    if (action.kind === "provision") {
      const spec = waiter.spec;
      if (spec !== undefined) {
        waiter.timing = estimatedTiming(this.#driverFor(spec.platform), spec);
      }
      await this.#provision(waiter, action);
      return;
    }
    if (action.kind === "boot-shutdown") {
      waiter.timing = estimatedBootTiming(
        this.#driverFor(action.device.spec.platform),
        action.device.spec,
      );
      await this.#bootShutdown(waiter, action.device);
      return;
    }
    waiter.timing = estimatedReclaimTiming(
      this.#driverFor(action.device.spec.platform),
      action.device.spec,
    );
    await this.#reclaimWarm(waiter, action.device);
  }

  async #provision(waiter: Waiter, _action: ProvisionAction): Promise<void> {
    const spec = waiter.spec;
    if (spec === undefined) {
      return;
    }
    const driver = this.#driverFor(spec.platform);
    const provisionStartedAt = this.options.clock.now();
    let driverDevice: DriverDevice;
    try {
      this.#notifyProgress(waiter, {
        stage: "provisioning",
        etaMs: driver.estimate("provision", spec),
      });
      driverDevice = await driver.provision(spec);
    } catch {
      const retry = await this.#withDecision(async () => {
        this.#removeReservation(spec.platform);
        if (waiter.state === "rejected") {
          return false;
        }
        waiter.failures += 1;
        if (waiter.failures === 1) {
          waiter.state = this.#queue.includes(waiter) ? "queued" : "new";
          return true;
        }
        this.#enqueue(waiter);
        return false;
      });
      if (retry) {
        void this.#drive(waiter);
      }
      return;
    }

    const device = await this.#withDecision(async () => {
      this.#removeReservation(spec.platform);
      return this.options.registry.registerDevice({
        driverData: driverDevice.driverData,
        driverDeviceId: driverDevice.deviceId,
        provisionDuration: this.options.clock.now() - provisionStartedAt,
        spec,
      });
    });

    const readyStartedAt = this.options.clock.now();
    try {
      this.#notifyProgress(waiter, { stage: "booting", etaMs: driver.estimate("boot", spec) });
      await driver.makeReady(driverDevice);
    } catch {
      await driver.destroy(driverDevice);
      await this.#withDecision(async () => {
        await this.options.registry.transitionDevice(device.id, "deleted", {
          event: "device.deleted",
          payload: { deviceId: device.id, initiator: "lease-engine" },
        });
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      return;
    }

    const granted = await this.#withDecision(async () => {
      await this.options.registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: this.options.clock.now() - readyStartedAt, deviceId: device.id },
      });
      if (waiter.state === "rejected") {
        return false;
      }
      await this.#grant(waiter, device.id);
      return true;
    });
    if (!granted) {
      this.#wakeQueue();
    }
  }

  async #decide(
    waiter: Waiter,
  ): Promise<ProvisionAction | ReclaimWarmAction | BootShutdownAction | undefined> {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }
    const spec = waiter.spec;
    if (this.#queue[0] !== undefined && this.#queue[0] !== waiter) {
      if (waiter.options.noWait) {
        this.#reject(waiter, new NoCapacityError(), "no-wait");
        return undefined;
      }
      this.#enqueue(waiter);
      return undefined;
    }

    const ready = this.options.registry.snapshot.devices.find(
      (device) =>
        device.state === "ready" &&
        !this.#cleanupReservations.has(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (ready !== undefined) {
      await this.#grant(waiter, ready.id);
      return undefined;
    }

    const warm = this.options.registry.snapshot.devices.find(
      (device) =>
        device.state === "warm" &&
        !this.#warmReservations.has(device.id) &&
        !this.#cleanupReservations.has(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (warm !== undefined) {
      this.#warmReservations.add(warm.id);
      waiter.state = "processing";
      return { device: warm, kind: "reclaim-warm" };
    }

    const shutdown = this.options.registry.snapshot.devices.find(
      (device) =>
        device.state === "shutdown" &&
        !this.#shutdownReservations.has(device.id) &&
        !this.#cleanupReservations.has(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (shutdown !== undefined) {
      this.#shutdownReservations.add(shutdown.id);
      waiter.state = "processing";
      return { device: shutdown, kind: "boot-shutdown" };
    }

    const capacity = canProvision(
      spec.platform,
      [
        ...this.options.registry.snapshot.devices.map((device) => ({
          platform: device.spec.platform,
          state: device.state,
        })),
        ...this.#provisionReservations.map((platform) => ({ platform, state: "provisioning" })),
      ],
      this.options.config,
      this.options.systemStats,
    );
    if (capacity.ok && waiter.failures < 2) {
      this.#provisionReservations.push(spec.platform);
      waiter.state = "processing";
      return { kind: "provision" };
    }

    if (waiter.options.noWait) {
      this.#reject(waiter, new NoCapacityError(), "no-wait");
      return undefined;
    }
    this.#enqueue(waiter);
    return undefined;
  }

  async #grant(waiter: Waiter, deviceId: string): Promise<void> {
    const ttlDeadline = this.options.clock.now() + this.#ttlFor(waiter.options.mode);
    const lease = await this.options.registry.createLease({
      deviceId,
      mode: waiter.options.mode,
      requesterId: waiter.options.requesterId,
      ttlDeadline,
    });
    const device = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === deviceId,
    );
    if (device === undefined) {
      throw new Error(`Granted device disappeared from registry: ${deviceId}`);
    }

    this.#removeFromQueue(waiter);
    if (waiter.timer !== undefined) {
      this.options.clock.cancel(waiter.timer);
      delete waiter.timer;
    }
    waiter.state = "granted";
    this.#armLeaseTimer(lease);
    this.options.eventBus.emit(
      "lease.granted",
      {
        deviceId: lease.deviceId,
        leaseId: lease.id,
        mode: lease.mode,
        requester: lease.requesterId,
      },
      "lease-engine",
    );
    waiter.resolve({ device, lease, timing: waiter.timing });
  }

  async #reclaimWarm(waiter: Waiter, device: DeviceRecord): Promise<void> {
    const driver = this.#driverFor(device.spec.platform);
    const startedAt = this.options.clock.now();
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      this.#notifyProgress(waiter, {
        stage: "reclaiming",
        etaMs: driver.estimate("reclaim", device.spec),
      });
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch {
      await this.#withDecision(async () => {
        this.#warmReservations.delete(device.id);
        if (waiter.state !== "rejected") {
          this.#enqueue(waiter);
        }
      });
      return;
    }

    const granted = await this.#withDecision(async () => {
      this.#warmReservations.delete(device.id);
      await this.options.registry.transitionDevice(device.id, result.state, {
        event: "device.reclaimed",
        payload: {
          deviceId: device.id,
          duration: this.options.clock.now() - startedAt,
          strategy: result.strategy,
        },
      });
      if (result.state !== "ready" || waiter.state === "rejected") {
        waiter.state = this.#queue.includes(waiter) ? "queued" : "new";
        return false;
      }
      await this.#grant(waiter, device.id);
      return true;
    });
    if (!granted) {
      void this.#drive(waiter);
    }
  }

  async #bootShutdown(waiter: Waiter, device: DeviceRecord): Promise<void> {
    const driver = this.#driverFor(device.spec.platform);
    const startedAt = this.options.clock.now();
    try {
      this.#notifyProgress(waiter, {
        stage: "booting",
        etaMs: driver.estimate("boot", device.spec),
      });
      await driver.makeReady(toDriverDevice(device));
    } catch {
      await driver.destroy(toDriverDevice(device));
      await this.#withDecision(async () => {
        this.#shutdownReservations.delete(device.id);
        await this.options.registry.transitionDevice(device.id, "deleted", {
          event: "device.deleted",
          payload: { deviceId: device.id, initiator: "lease-engine" },
        });
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      return;
    }

    const granted = await this.#withDecision(async () => {
      this.#shutdownReservations.delete(device.id);
      await this.options.registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: this.options.clock.now() - startedAt, deviceId: device.id },
      });
      if (waiter.state !== "rejected") {
        await this.#grant(waiter, device.id);
        return true;
      }
      return false;
    });
    if (!granted) {
      this.#wakeQueue();
    }
  }

  async #release(
    leaseId: string,
    reason: "closed" | "explicit" | "killed" | "expired",
  ): Promise<void> {
    const released = await this.#withDecision(async () => {
      const result = await this.options.registry.beginRelease(leaseId);
      this.#cancelLeaseTimer(leaseId);
      this.#requesters.delete(result.lease.requesterId);
      if (reason === "expired") {
        this.options.eventBus.emit(
          "lease.expired",
          { deviceId: result.lease.deviceId, leaseId: result.lease.id },
          "lease-engine",
        );
      } else {
        this.options.eventBus.emit(
          "lease.released",
          { deviceId: result.lease.deviceId, leaseId: result.lease.id, reason },
          "lease-engine",
        );
      }
      return result;
    });

    await this.#reclaim(released);
  }

  async #reclaim(released: ReleasedLease): Promise<void> {
    const driver = this.#driverFor(released.device.spec.platform);
    const startedAt = this.options.clock.now();
    const result = await driver.reclaim(toDriverDevice(released.device), { clean: "standard" });
    await this.#withDecision(async () => {
      await this.options.registry.transitionDevice(released.device.id, result.state, {
        event: "device.reclaimed",
        payload: {
          deviceId: released.device.id,
          duration: this.options.clock.now() - startedAt,
          strategy: result.strategy,
        },
      });
    });
    this.#wakeQueue();
  }

  #enqueue(waiter: Waiter): void {
    if (waiter.state === "rejected" || waiter.state === "granted") {
      return;
    }
    if (!this.#queue.includes(waiter)) {
      this.#queue.push(waiter);
      waiter.state = "queued";
      this.options.eventBus.emit(
        "lease.queued",
        { queuePosition: this.#queue.length, requestId: waiter.id },
        "lease-engine",
      );
      this.#notifyProgress(waiter, { queuePosition: this.#queue.length, stage: "queued" });
    }
    waiter.state = "queued";
    if (waiter.timer === undefined && waiter.options.timeoutMs !== undefined) {
      waiter.timer = this.options.clock.setTimer(waiter.options.timeoutMs, () => {
        void this.#withDecision(async () => {
          if (waiter.state === "queued") {
            this.#reject(waiter, new QueueTimeoutError(waiter.id), "timeout");
            this.#wakeQueue();
          }
        });
      });
    }
  }

  #reject(
    waiter: Waiter,
    error: Error,
    reason:
      | "timeout"
      | "no-wait"
      | "unresolvable-spec"
      | "already-leased"
      | "boot-timeout"
      | "killed",
  ): void {
    if (waiter.state === "rejected" || waiter.state === "granted") {
      return;
    }
    this.#removeFromQueue(waiter);
    if (waiter.timer !== undefined) {
      this.options.clock.cancel(waiter.timer);
      delete waiter.timer;
    }
    waiter.state = "rejected";
    this.#requesters.delete(waiter.options.requesterId);
    this.options.eventBus.emit(
      "lease.rejected",
      { requestSpec: waiter.request, reason },
      "lease-engine",
    );
    waiter.reject(error);
  }

  #wakeQueue(): void {
    void this.#withDecision(async () => {
      const next = this.#queue[0];
      if (next !== undefined && next.state === "queued") {
        void this.#drive(next);
      }
    });
  }

  #newWaiter(request: DeviceRequest, options: LeaseRequestOptions): Waiter {
    let resolve!: (grant: LeaseGrant) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<LeaseGrant>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return {
      failures: 0,
      id: `req_${this.options.idGenerator.generate()}`,
      options,
      onProgress: options.onProgress,
      promise,
      reject,
      request,
      resolve,
      state: "new",
      timing: noTiming,
    };
  }

  #notifyProgress(waiter: Waiter, progress: LeaseProgress): void {
    try {
      waiter.onProgress?.(progress);
    } catch {
      // Client feedback must not affect lease acquisition.
    }
  }

  #ttlFor(mode: LeaseRecord["mode"]): number {
    return mode === "held"
      ? this.options.config.lease.heldTtlBackstopMs
      : this.options.config.lease.detachedTtlMs;
  }

  #armLeaseTimer(lease: LeaseRecord): void {
    this.#leaseTimers.set(
      lease.id,
      this.options.clock.setTimer(Math.max(0, lease.ttlDeadline - this.options.clock.now()), () => {
        void this.#release(lease.id, "expired");
      }),
    );
  }

  #cancelLeaseTimer(leaseId: string): void {
    const timer = this.#leaseTimers.get(leaseId);
    if (timer !== undefined) {
      this.options.clock.cancel(timer);
      this.#leaseTimers.delete(leaseId);
    }
  }

  #removeReservation(platform: Platform): void {
    const index = this.#provisionReservations.indexOf(platform);
    if (index !== -1) {
      this.#provisionReservations.splice(index, 1);
    }
  }

  #removeFromQueue(waiter: Waiter): void {
    const index = this.#queue.indexOf(waiter);
    if (index !== -1) {
      this.#queue.splice(index, 1);
    }
  }

  #canExecuteCleanup(device: DeviceRecord, action: "shutdown" | "destroy"): boolean {
    if (
      this.#cleanupReservations.has(device.id) ||
      this.options.registry.snapshot.leases.some((lease) => lease.deviceId === device.id)
    ) {
      return false;
    }

    return (
      (action === "shutdown" && (device.state === "ready" || device.state === "warm")) ||
      (action === "destroy" && device.state === "shutdown")
    );
  }

  #driverFor(platform: Platform): Driver {
    const driver = this.#drivers.get(platform);
    if (driver === undefined) {
      throw new NoDriverError(platform);
    }
    return driver;
  }

  async #withDecision<Result>(operation: () => Promise<Result>): Promise<Result> {
    let release!: () => void;
    const previous = this.#decisionTail;
    this.#decisionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function estimatedTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedProvisionMs = driver.estimate("provision", spec);
  const estimatedBootMs = driver.estimate("boot", spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs,
    estimatedReclaimMs: 0,
    estimatedReadyMs: estimatedProvisionMs + estimatedBootMs,
  };
}

function estimatedReclaimTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedReclaimMs = driver.estimate("reclaim", spec);
  return {
    estimatedBootMs: 0,
    estimatedProvisionMs: 0,
    estimatedReclaimMs,
    estimatedReadyMs: estimatedReclaimMs,
  };
}

function estimatedBootTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedBootMs = driver.estimate("boot", spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: 0,
    estimatedReadyMs: estimatedBootMs,
  };
}

function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion
  );
}

function toDriverDevice(device: DeviceRecord): DriverDevice {
  return { deviceId: device.driverDeviceId, driverData: device.driverData };
}
