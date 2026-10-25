import type { EventBus } from "../bus/index.js";
import { quarantineCauseMessage } from "../contract/index.js";
import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../ports/index.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import {
  type DeviceRecord,
  type DeviceState,
  mayBeGranted,
  type PhysicalDevice,
  type Platform,
  type QuarantineCause,
  type VirtualDevice,
} from "./domain.js";
import { type Driver, toDriverDevice } from "./driver.js";
import { readPhysicalPresence } from "./physical-presence.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

export interface QuarantineDriverCatalog {
  get(platform: Platform): Driver;
}

export interface QuarantineRegistry {
  readonly snapshot: { readonly devices: readonly DeviceRecord[] };
  enterQuarantine(
    deviceId: string,
    nextRetryAt: number,
    cause: QuarantineCause,
  ): Promise<DeviceRecord>;
  recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<DeviceRecord>;
  recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<DeviceRecord>;
  strandQuarantine(deviceId: string, attempts: number): Promise<DeviceRecord>;
  deleteQuarantined(deviceId: string, initiator: string): Promise<DeviceRecord>;
}

export interface QuarantinePurgeFailure {
  readonly deviceId: string;
  readonly leaseId?: string | undefined;
  readonly kind: "purge-failed" | "shutdown-failed" | "delete-failed";
  readonly attemptedStrategy: "erase" | "snapshot" | "wipe" | "delete" | "uninstall";
  readonly duration: number;
  readonly error: string;
}

export interface QuarantineRetryConfig {
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly retryBackoffMultiplier: number;
  readonly maxRetryBackoffMs: number;
}

export interface QuarantineCoordinatorOptions {
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly clock: Clock;
  readonly config: QuarantineRetryConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: QuarantineDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly notifyAvailability: () => void;
  readonly physicalDeviceReady?: (deviceId: string) => void;
  readonly probeIntervalMs?: number;
  readonly registry: QuarantineRegistry;
  readonly logger?: Logger;
}

export class QuarantineCoordinator {
  readonly #timers = new Map<string, TimerHandle>();
  #disposed = false;
  readonly #logger: Logger;

  constructor(private readonly options: QuarantineCoordinatorOptions) {
    this.#logger = options.logger?.child("quarantine-coordinator") ?? new NoopLogger();
  }

  // No `notifyAvailability`: a quarantined virtual device still counts as running, and a physical device counts toward no capacity, so no waiter can be satisfied by this.
  async enter(failure: QuarantinePurgeFailure): Promise<void> {
    const nextRetryAt = this.options.clock.now() + this.options.config.retryBackoffMs;
    await this.options.decisions.run(async () => {
      const message = quarantineCauseMessage(failure.error);
      const cause: QuarantineCause = {
        kind: failure.kind,
        ...(message === undefined ? {} : { message }),
      };
      const entered = await this.options.registry.enterQuarantine(
        failure.deviceId,
        nextRetryAt,
        cause,
      );
      if (failure.leaseId !== undefined) {
        this.options.eventBus.emit(
          "device.purge-failed",
          {
            attemptedStrategy: failure.attemptedStrategy,
            deviceId: failure.deviceId,
            duration: failure.duration,
            error: failure.error,
            leaseId: failure.leaseId,
          },
          "quarantine-coordinator",
        );
      }
      this.options.eventBus.emit(
        "device.quarantined",
        {
          deviceId: failure.deviceId,
          maxRetries: this.options.config.maxRetries,
          nextRetryAt,
          platform: entered.spec.platform,
          ...cause,
        },
        "quarantine-coordinator",
      );
    });
    this.#arm(failure.deviceId, nextRetryAt);
  }

  /**
   * why: the claim is taken here and released on every exit, so a reclaim the watcher has just started is never quarantined under it.
   * Answers whether it entered: a caller handing a device over needs to know when one was already claimed or had moved on.
   */
  async enterFromStalledTransition(deviceId: string, findingState: DeviceState): Promise<boolean> {
    const nextRetryAt = this.options.clock.now() + this.options.config.retryBackoffMs;
    const entered = await this.options.decisions.run(async () => {
      const current = this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId,
      );
      if (current?.state !== findingState) return false;
      const claim = this.options.claims.tryClaim(deviceId, "reclaim");
      if (claim === undefined) return false;
      // why: a transition the watcher found stalled is `stalled`; any other state is a lease-engine hand-over after a failed destroy.
      const cause: QuarantineCause =
        findingState === "provisioning" || findingState === "reclaiming"
          ? { kind: "stalled", stalledState: findingState }
          : { kind: "delete-failed" };
      let entered: DeviceRecord;
      try {
        entered = await this.options.registry.enterQuarantine(deviceId, nextRetryAt, cause);
      } finally {
        claim.release();
      }
      this.options.eventBus.emit(
        "device.quarantined",
        {
          deviceId,
          maxRetries: this.options.config.maxRetries,
          nextRetryAt,
          platform: entered.spec.platform,
          ...cause,
        },
        "quarantine-coordinator",
      );
      return true;
    });
    if (entered) this.#arm(deviceId, nextRetryAt);
    return entered;
  }

  restore(include: (device: DeviceRecord) => boolean = () => true): void {
    for (const device of this.options.registry.snapshot.devices) {
      if (device.state !== "quarantined" || !include(device)) continue;
      this.#arm(device.id, device.quarantineNextRetryAt ?? this.options.clock.now());
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers.values()) this.options.clock.cancel(timer);
    this.#timers.clear();
  }

  #arm(deviceId: string, nextRetryAt: number): void {
    if (this.#disposed) return;
    const existing = this.#timers.get(deviceId);
    if (existing !== undefined) this.options.clock.cancel(existing);
    const delay = Math.max(0, nextRetryAt - this.options.clock.now());
    this.#timers.set(
      deviceId,
      this.options.clock.setTimer(delay, () => {
        this.#timers.delete(deviceId);
        void this.#retry(deviceId).catch((error: unknown) => {
          this.#logger.error("quarantine retry threw", {
            deviceId,
            step: "retry",
            error: stableError(error),
          });
        });
      }),
    );
  }

  async #retry(deviceId: string): Promise<void> {
    if (this.#disposed) return;
    // A re-read that finds the device gone or moved on means a stale timer fired: nothing to do.
    const device = await this.options.decisions.run(() =>
      this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId && candidate.state === "quarantined",
      ),
    );
    if (device === undefined) return;

    const claim = this.options.claims.tryClaim(deviceId, "reclaim");
    if (claim === undefined) {
      this.#arm(deviceId, this.options.clock.now() + this.options.config.retryBackoffMs);
      return;
    }
    try {
      await this.#retryClaimed(device, claim);
    } finally {
      claim.release();
    }
  }

  /**
   * Every exit releases the claim right after the last write, before the coordinator's own facts
   * and the wake-up that follow it: the planner never grants a claimed device, so a wake-up under
   * the claim would pass over the device it was sent for.
   */
  async #retryClaimed(device: DeviceRecord, claim: DeviceOperationClaim): Promise<void> {
    if (device.physical && !(await this.#presentForRetry(device))) {
      await this.#waitForPresence(device);
      return;
    }
    const attempts = (device.quarantineAttempts ?? 0) + 1;
    const driver = this.options.drivers.get(device.spec.platform);
    if (!device.physical && !mayBeGranted(device)) {
      await this.#retryDelete(driver, device, attempts, claim);
      return;
    }
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch (error: unknown) {
      this.#logRetryFailure("quarantine reclaim retry failed", device, "reclaim", attempts, error);
      await this.#retryFailed(device, attempts, claim);
      return;
    }

    await this.#recovered(device, result, attempts, claim);
  }

  async #recovered(
    device: DeviceRecord,
    result: Awaited<ReturnType<Driver["reclaim"]>>,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    await this.options.decisions.run(() =>
      this.options.registry.recoverFromQuarantine(device.id, result.state),
    );
    claim.release();
    if (device.physical) this.options.physicalDeviceReady?.(device.id);
    this.options.eventBus.emit(
      "device.quarantine-recovered",
      {
        attempts,
        deviceId: device.id,
        strategy: result.strategy,
        platform: device.spec.platform,
        ...(result.missingApps === undefined ? {} : { missingApps: result.missingApps }),
      },
      "quarantine-coordinator",
    );
    this.options.notifyAvailability();
  }

  /**
   * why: a physical device that is not there cannot be reclaimed, and a retry that fails for want of
   * it would only count toward unenrolling it. A read that fails, or a platform with no driver,
   * is not presence.
   */
  async #presentForRetry(device: PhysicalDevice): Promise<boolean> {
    try {
      const driver = this.options.drivers.get(device.spec.platform);
      const presence = await readPhysicalPresence(driver, [device.driverDeviceId]);
      return presence.get(device.driverDeviceId) === true;
    } catch (error: unknown) {
      this.#logger.warn("quarantine presence read failed", {
        deviceId: device.id,
        step: "presence",
        error: stableError(error),
      });
      return false;
    }
  }

  /** why: the attempt count stays as it was; only the due time moves on, so `status` never shows one that has passed. */
  async #waitForPresence(device: PhysicalDevice): Promise<void> {
    const nextRetryAt =
      this.options.clock.now() +
      (this.options.probeIntervalMs ?? this.options.config.retryBackoffMs);
    await this.options.decisions.run(() =>
      this.options.registry.recordQuarantineRetryFailure(
        device.id,
        device.quarantineAttempts ?? 0,
        nextRetryAt,
      ),
    );
    this.#arm(device.id, nextRetryAt);
  }

  /** A spent fresh device already served its one lease, so a successful reclaim would put it back in the pool for a second one. */
  async #retryDelete(
    driver: Driver,
    device: VirtualDevice,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      await driver.destroy(toDriverDevice(device));
    } catch (error: unknown) {
      this.#logRetryFailure("quarantine delete retry failed", device, "delete", attempts, error);
      await this.#retryFailed(device, attempts, claim);
      return;
    }
    await this.options.decisions.run(() =>
      this.options.registry.deleteQuarantined(device.id, "lease-end"),
    );
    claim.release();
    this.options.notifyAvailability();
  }

  #logRetryFailure(
    message: string,
    device: DeviceRecord,
    step: string,
    attempts: number,
    error: unknown,
  ): void {
    this.#logger.warn(message, { deviceId: device.id, step, attempts, error: stableError(error) });
  }

  async #retryFailed(
    device: DeviceRecord,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    if (attempts >= this.options.config.maxRetries) {
      await this.#giveUp(device, attempts, claim);
      return;
    }
    const nextRetryAt = this.options.clock.now() + backoffDelay(this.options.config, attempts);
    await this.options.decisions.run(() =>
      this.options.registry.recordQuarantineRetryFailure(device.id, attempts, nextRetryAt),
    );
    this.#arm(device.id, nextRetryAt);
  }

  async #giveUp(
    device: DeviceRecord,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    if (device.physical) {
      await this.#unenroll(device, attempts, claim);
      return;
    }
    const driver = this.options.drivers.get(device.spec.platform);
    try {
      await driver.destroy(toDriverDevice(device));
    } catch (error: unknown) {
      // Leave it quarantined and counted against capacity: reusing a dirty device or losing
      // track of one is worse. No retry is scheduled; only an operator leaves this state.
      await this.options.decisions.run(() =>
        this.options.registry.strandQuarantine(device.id, attempts),
      );
      claim.release();
      this.options.eventBus.emit(
        "device.quarantine-stranded",
        {
          attempts,
          deviceId: device.id,
          error: stableError(error),
          platform: device.spec.platform,
        },
        "quarantine-coordinator",
      );
      return;
    }
    await this.options.decisions.run(() =>
      this.options.registry.deleteQuarantined(device.id, "quarantine-coordinator"),
    );
    this.#abandoned(device, attempts, claim);
  }

  /** A physical device is the owner's: running out of retries unenrols it and never destroys it (safety rule 1). */
  async #unenroll(
    device: DeviceRecord,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    await this.options.decisions.run(() =>
      this.options.registry.deleteQuarantined(device.id, "quarantine"),
    );
    this.#abandoned(device, attempts, claim);
  }

  #abandoned(device: DeviceRecord, attempts: number, claim: DeviceOperationClaim): void {
    claim.release();
    this.options.eventBus.emit(
      "device.quarantine-abandoned",
      { attempts, deviceId: device.id, platform: device.spec.platform },
      "quarantine-coordinator",
    );
    this.options.notifyAvailability();
  }
}

function backoffDelay(config: QuarantineRetryConfig, attemptsSoFar: number): number {
  return Math.min(
    config.retryBackoffMs * config.retryBackoffMultiplier ** attemptsSoFar,
    config.maxRetryBackoffMs,
  );
}
