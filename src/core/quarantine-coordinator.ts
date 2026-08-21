import type { EventBus } from "../bus/index.js";
import type { Clock, TimerHandle } from "../ports/index.js";
import type { DeviceRecord, Platform } from "./domain.js";
import type { Driver, DriverDevice } from "./driver.js";
import type { SerializedDecision } from "./serialized-decision.js";

export interface QuarantineDriverCatalog {
  get(platform: Platform): Driver;
}

export interface QuarantineRegistry {
  readonly snapshot: { readonly devices: readonly DeviceRecord[] };
  enterQuarantine(deviceId: string, nextRetryAt: number): Promise<DeviceRecord>;
  recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<DeviceRecord>;
  recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<DeviceRecord>;
  strandQuarantine(deviceId: string, attempts: number): Promise<DeviceRecord>;
  abandonQuarantine(deviceId: string): Promise<DeviceRecord>;
}

export interface QuarantinePurgeFailure {
  readonly deviceId: string;
  readonly leaseId: string;
  readonly attemptedStrategy: "erase" | "snapshot" | "wipe";
  readonly duration: number;
  readonly error: string;
}

export interface QuarantineRetryConfig {
  /** Failed retries allowed after the triggering purge failure before giving up. */
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly retryBackoffMultiplier: number;
  readonly maxRetryBackoffMs: number;
}

export interface QuarantineCoordinatorOptions {
  readonly clock: Clock;
  readonly config: QuarantineRetryConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: QuarantineDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly notifyAvailability: () => void;
  readonly registry: QuarantineRegistry;
}

/**
 * Owns the release-time purge-failure recovery lifecycle. `quarantined` is the
 * shared "present in the registry, counts against running capacity, but not
 * grantable" disposition (see domain.ts): AcquisitionPlanner and the warm-pool
 * eviction helpers already select targets by exact state, so a quarantined
 * device is invisible to every one of them with no special-casing required.
 *
 * A quarantined device retries its purge on a Clock-driven backoff until it
 * either succeeds (the device rejoins the warm pool) or exhausts
 * `config.maxRetries`, at which point it is destroyed -- never merely shut
 * down, since `shutdown` is a state AcquisitionPlanner treats as reusable
 * warm inventory (`boot-shutdown`), which would silently reintroduce the
 * exact dirty-device bug this coordinator exists to prevent.
 */
export class QuarantineCoordinator {
  readonly #timers = new Map<string, TimerHandle>();
  #disposed = false;

  constructor(private readonly options: QuarantineCoordinatorOptions) {}

  /**
   * Commits quarantine entry for a device whose release-time purge just
   * failed, emits the (unchanged) `device.purge-failed` fact alongside the
   * new `device.quarantined` fact, and arms the first retry. Capacity
   * accounting does not change here -- `reclaiming` and `quarantined` both
   * count as running -- so no queued waiter can be satisfied by this alone
   * and `notifyAvailability` is not called.
   */
  async enter(failure: QuarantinePurgeFailure): Promise<void> {
    const nextRetryAt = this.options.clock.now() + this.options.config.retryBackoffMs;
    await this.options.decisions.run(async () => {
      await this.options.registry.enterQuarantine(failure.deviceId, nextRetryAt);
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
      this.options.eventBus.emit(
        "device.quarantined",
        { deviceId: failure.deviceId, maxRetries: this.options.config.maxRetries, nextRetryAt },
        "quarantine-coordinator",
      );
    });
    this.#arm(failure.deviceId, nextRetryAt);
  }

  /**
   * Re-arms retry timers for devices still `quarantined` after a daemon
   * restart, using the persisted `quarantineNextRetryAt` (a retry already due
   * fires immediately, same as `LeaseExpiryScheduler.restore`).
   */
  restore(): void {
    for (const device of this.options.registry.snapshot.devices) {
      if (device.state !== "quarantined") continue;
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
        void this.#retry(deviceId).catch(() => undefined);
      }),
    );
  }

  async #retry(deviceId: string): Promise<void> {
    if (this.#disposed) return;
    // A device leaves `quarantined` only through this coordinator (recovered or
    // abandoned), so a re-read that finds it gone or moved on means a stale
    // timer fired after the fact -- nothing to do.
    const device = await this.options.decisions.run(() =>
      this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId && candidate.state === "quarantined",
      ),
    );
    if (device === undefined) return;

    const attempts = (device.quarantineAttempts ?? 0) + 1;
    const driver = this.options.drivers.get(device.spec.platform);
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch {
      await this.#retryFailed(device, attempts);
      return;
    }

    await this.options.decisions.run(() =>
      this.options.registry.recoverFromQuarantine(deviceId, result.state),
    );
    this.options.eventBus.emit(
      "device.quarantine-recovered",
      { attempts, deviceId, strategy: result.strategy },
      "quarantine-coordinator",
    );
    this.options.notifyAvailability();
  }

  async #retryFailed(device: DeviceRecord, attempts: number): Promise<void> {
    if (attempts >= this.options.config.maxRetries) {
      await this.#giveUp(device, attempts);
      return;
    }
    const nextRetryAt = this.options.clock.now() + backoffDelay(this.options.config, attempts);
    await this.options.decisions.run(() =>
      this.options.registry.recordQuarantineRetryFailure(device.id, attempts, nextRetryAt),
    );
    this.#arm(device.id, nextRetryAt);
  }

  async #giveUp(device: DeviceRecord, attempts: number): Promise<void> {
    const driver = this.options.drivers.get(device.spec.platform);
    try {
      await driver.destroy(toDriverDevice(device));
    } catch (error: unknown) {
      // Destroy itself failed: leave the device quarantined -- still uncounted
      // against a grant, still counted against capacity -- rather than either
      // reusing a dirty device or losing track of one that never got cleaned
      // up. No further retry is scheduled, so this is a terminal state that
      // only an operator (`pitlane doctor` / `nuke`) leaves; emit it as its own
      // fact rather than letting a device strand itself in silence.
      await this.options.decisions.run(() =>
        this.options.registry.strandQuarantine(device.id, attempts),
      );
      this.options.eventBus.emit(
        "device.quarantine-stranded",
        { attempts, deviceId: device.id, error: stableError(error) },
        "quarantine-coordinator",
      );
      return;
    }
    await this.options.decisions.run(() => this.options.registry.abandonQuarantine(device.id));
    this.options.eventBus.emit(
      "device.quarantine-abandoned",
      { attempts, deviceId: device.id },
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

function stableError(error: unknown): string {
  const value = error instanceof Error ? error : new Error(String(error));
  return `${value.name}: ${value.message}`;
}

function toDriverDevice(device: DeviceRecord): DriverDevice {
  return { deviceId: device.driverDeviceId, driverData: device.driverData };
}
