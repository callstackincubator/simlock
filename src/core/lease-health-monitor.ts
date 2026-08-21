import type { EventBus } from "../bus/index.js";
import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../ports/index.js";
import type { Config } from "./config.js";
import type { DeviceRecord, LeaseRecord, Platform } from "./domain.js";
import type { DriverCatalog } from "./driver-catalog.js";
import type { ObservedDevice, ObservedMark } from "./driver.js";

export interface HealthMonitorRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
  markRecoveryAttempt(deviceId: string, at: number): Promise<DeviceRecord>;
  clearRecovery(deviceId: string): Promise<DeviceRecord>;
}

export interface HealthMonitorLifecycle {
  recoverLeased(target: DeviceRecord, leaseId: string): Promise<DeviceRecord | undefined>;
}

/** Releases a lease whose device is gone for good. Internally originated only. */
export interface DeviceLostReleaser {
  releaseDeviceLost(leaseId: string): Promise<void>;
}

export interface LeaseHealthMonitorOptions {
  readonly clock: Clock;
  readonly config: Config;
  readonly drivers: DriverCatalog;
  readonly eventBus: EventBus;
  readonly lifecycle: HealthMonitorLifecycle;
  readonly logger?: Logger;
  readonly registry: HealthMonitorRegistry;
  readonly releaser: DeviceLostReleaser;
}

type GiveUpReason = "attempts-exhausted" | "device-missing" | "provenance-drift";

interface CrashCounters {
  missing: number;
  stopped: number;
}

/**
 * Periodically observes `leased` devices, reboots one whose process crashed
 * outside simlock under its existing lease, and releases the lease as
 * `device-lost` when recovery is impossible or exhausted. Not event-triggered
 * -- purely a `Clock`-driven tick, modelled on `CleanupReaper`.
 *
 * Does not arm on construction: callers must call `start()` explicitly (see
 * the constructor's doc for why) and `dispose()` to tear down.
 */
export class LeaseHealthMonitor {
  readonly #counters = new Map<string, CrashCounters>();
  readonly #inFlight = new Set<string>();
  readonly #logger: Logger;
  readonly #pendingBackoffs = new Map<TimerHandle, () => void>();
  #disposed = false;
  #tickTimer: TimerHandle | undefined;

  constructor(private readonly options: LeaseHealthMonitorOptions) {
    this.#logger = options.logger?.child("lease-health-monitor") ?? new NoopLogger();
  }

  /**
   * Arms the recurring probe tick. Deliberately not done in the constructor:
   * `LeaseEngine` (and its tests) construct their dependencies while driving a
   * `FakeClock` directly, and a self-arming monitor would inject surprise
   * `listManaged()` driver calls into every one of those tests.
   */
  start(): void {
    if (this.#disposed || !this.options.config.health.enabled) {
      return;
    }
    this.#armTick();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#tickTimer !== undefined) {
      this.options.clock.cancel(this.#tickTimer);
      this.#tickTimer = undefined;
    }
    for (const [timer, resolve] of this.#pendingBackoffs) {
      this.options.clock.cancel(timer);
      resolve();
    }
    this.#pendingBackoffs.clear();
  }

  #armTick(): void {
    if (this.#disposed) {
      return;
    }
    this.#tickTimer = this.options.clock.setTimer(
      this.options.config.health.probeIntervalMs,
      () => {
        this.#tickTimer = undefined;
        void this.#runTick().then(
          () => this.#armTick(),
          (error: unknown) => {
            this.#logger.error("health monitor tick failed", { error: summarizeError(error) });
            this.#armTick();
          },
        );
      },
    );
  }

  /**
   * One probe pass: poll each affected platform's driver once, classify every
   * leased device, and kick off (but never await) recovery for the ones that
   * need it. Recovery runs detached so a slow reboot never blocks the next
   * tick -- only per-device dispatch is guarded, via `#inFlight`.
   */
  async #runTick(): Promise<void> {
    const snapshot = this.options.registry.snapshot;
    const leased = snapshot.devices.filter((device) => device.state === "leased");
    this.#dropStaleCounters(leased);

    const observedByPlatform = await this.#pollDrivers(leased);

    for (const device of leased) {
      if (this.#inFlight.has(device.id)) {
        continue;
      }
      const lease = snapshot.leases.find((candidate) => candidate.deviceId === device.id);
      if (lease === undefined) {
        // A release is racing this tick; nothing to classify against.
        this.#counters.delete(device.id);
        continue;
      }
      const observedDevices = observedByPlatform.get(device.spec.platform);
      if (observedDevices === undefined) {
        // This platform's listManaged() failed this tick; skip rather than misread it as a crash.
        continue;
      }
      const observed = observedDevices.find(
        (candidate) => candidate.deviceId === device.driverDeviceId,
      );
      try {
        const shouldRecover = await this.#classify(device, lease, observed);
        if (shouldRecover) {
          this.#dispatchRecovery(device, lease);
        }
      } catch (error: unknown) {
        // Classification writes to the registry (clearRecovery), which throws if the
        // device disappeared between this tick's snapshot and the write. One device's
        // bad luck must not cost the remaining leased devices their turn this tick.
        this.#logger.warn("failed to classify leased device", {
          deviceId: device.id,
          error: summarizeError(error),
        });
      }
    }
  }

  #dropStaleCounters(leased: readonly DeviceRecord[]): void {
    const leasedIds = new Set(leased.map((device) => device.id));
    for (const deviceId of this.#counters.keys()) {
      if (!leasedIds.has(deviceId)) {
        this.#counters.delete(deviceId);
      }
    }
  }

  async #pollDrivers(
    leased: readonly DeviceRecord[],
  ): Promise<ReadonlyMap<Platform, readonly ObservedDevice[]>> {
    const observedByPlatform = new Map<Platform, readonly ObservedDevice[]>();
    const platforms = new Set(leased.map((device) => device.spec.platform));
    for (const platform of platforms) {
      try {
        const reality = await this.options.drivers.get(platform).listManaged();
        observedByPlatform.set(platform, reality.devices);
      } catch (error: unknown) {
        // One bad shell-out must never be read as evidence of a crash.
        this.#logger.warn("listManaged failed; skipping platform for this tick", {
          error: summarizeError(error),
          platform,
        });
      }
    }
    return observedByPlatform;
  }

  /** Updates crash counters for one device and reports whether it needs a recovery attempt. */
  async #classify(
    device: DeviceRecord,
    lease: LeaseRecord,
    observed: ObservedDevice | undefined,
  ): Promise<boolean> {
    const counters = this.#counters.get(device.id) ?? { missing: 0, stopped: 0 };
    this.#counters.set(device.id, counters);

    if (observed === undefined) {
      return this.#classifyMissing(device, lease, counters);
    }
    if (observed.runState === "running") {
      return this.#classifyRunning(device, lease, counters, observed);
    }
    if (observed.runState === "transitioning") {
      // `Booting` / `Shutting Down` / adb-offline: inconclusive, leave counters unchanged.
      return false;
    }
    return this.#classifyStopped(counters);
  }

  async #classifyMissing(
    device: DeviceRecord,
    lease: LeaseRecord,
    counters: CrashCounters,
  ): Promise<boolean> {
    counters.missing += 1;
    counters.stopped = 0;
    if (counters.missing >= this.options.config.health.stableObservations) {
      await this.#giveUp(device, lease, "device-missing", device.recoveryAttempts ?? 0, undefined);
    }
    return false;
  }

  async #classifyRunning(
    device: DeviceRecord,
    lease: LeaseRecord,
    counters: CrashCounters,
    observed: ObservedDevice,
  ): Promise<boolean> {
    counters.missing = 0;
    counters.stopped = 0;
    if (device.recoveringSince !== undefined || device.recoveryAttempts !== undefined) {
      await this.options.registry.clearRecovery(device.id);
    }
    // A stopped device cannot be read reliably (Android's erasable mark lives on the
    // userdata partition, reachable only over adb while the emulator runs), so provenance
    // drift is only ever trusted while the device is running.
    const drift = observed.mark === undefined ? undefined : provenanceDrift(observed.mark);
    if (drift !== undefined) {
      await this.#giveUp(device, lease, "provenance-drift", device.recoveryAttempts ?? 0, drift);
    }
    return false;
  }

  #classifyStopped(counters: CrashCounters): boolean {
    counters.stopped += 1;
    counters.missing = 0;
    return counters.stopped >= this.options.config.health.stableObservations;
  }

  /** Starts a detached recovery attempt if the concurrency cap allows it this tick. */
  #dispatchRecovery(device: DeviceRecord, lease: LeaseRecord): void {
    if (this.#inFlight.size >= this.options.config.health.maxConcurrentRecoveries) {
      // Cap reached; this device's counters stay elevated and it is retried next tick.
      return;
    }
    this.#inFlight.add(device.id);
    void this.#recover(device, lease)
      .catch((error: unknown) => {
        this.#logger.error("unexpected error recovering device", {
          deviceId: device.id,
          error: summarizeError(error),
        });
      })
      .finally(() => this.#inFlight.delete(device.id));
  }

  /** Makes exactly one recovery attempt for a crashed device; retries land on later ticks. */
  async #recover(device: DeviceRecord, lease: LeaseRecord): Promise<void> {
    const attemptsSoFar = device.recoveryAttempts ?? 0;
    if (attemptsSoFar >= this.options.config.health.maxRecoveryAttempts) {
      await this.#giveUp(device, lease, "attempts-exhausted", attemptsSoFar, undefined);
      return;
    }

    const recorded = await this.options.registry.markRecoveryAttempt(
      device.id,
      this.options.clock.now(),
    );
    const attempt = recorded.recoveryAttempts ?? attemptsSoFar + 1;

    if (attempt === 1) {
      // A fact about the crash itself, not about each retry -- fired once per crash.
      this.options.eventBus.emit(
        "device.crash-detected",
        {
          deviceId: device.id,
          leaseId: lease.id,
          observed: "stopped",
          platform: device.spec.platform,
        },
        "lease-health-monitor",
      );
    } else {
      await this.#wait(this.options.config.health.recoveryBackoffMs * 2 ** (attempt - 2));
      if (this.#disposed) {
        return;
      }
    }

    await this.#attemptReboot(device, lease, attempt);
  }

  async #attemptReboot(device: DeviceRecord, lease: LeaseRecord, attempt: number): Promise<void> {
    const startedAt = this.options.clock.now();
    let recovered: DeviceRecord | undefined;
    try {
      recovered = await this.options.lifecycle.recoverLeased(device, lease.id);
    } catch (error: unknown) {
      this.#logger.warn("recovery reboot attempt failed", {
        attempt,
        deviceId: device.id,
        error: summarizeError(error),
      });
      if (attempt >= this.options.config.health.maxRecoveryAttempts) {
        await this.#giveUp(device, lease, "attempts-exhausted", attempt, summarizeError(error));
      }
      return;
    }

    if (recovered === undefined) {
      // The world changed under us -- lease released, TTL expired, device claimed
      // elsewhere. Not a failure: nothing more to do for this device.
      this.#counters.delete(device.id);
      return;
    }

    await this.options.registry.clearRecovery(device.id);
    this.#counters.delete(device.id);
    this.options.eventBus.emit(
      "device.recovered",
      {
        attempts: attempt,
        deviceId: device.id,
        duration: this.options.clock.now() - startedAt,
        leaseId: lease.id,
      },
      "lease-health-monitor",
    );
  }

  async #giveUp(
    device: DeviceRecord,
    lease: LeaseRecord,
    reason: GiveUpReason,
    attempts: number,
    error: string | undefined,
  ): Promise<void> {
    this.options.eventBus.emit(
      "device.recovery-failed",
      { attempts, deviceId: device.id, error: error ?? "", leaseId: lease.id, reason },
      "lease-health-monitor",
    );

    try {
      await this.options.releaser.releaseDeviceLost(lease.id);
    } catch (releaseError: unknown) {
      // Must never kill the tick loop; the lease stays live and is retried next tick.
      this.#logger.error("releaseDeviceLost failed", {
        deviceId: device.id,
        error: summarizeError(releaseError),
        leaseId: lease.id,
      });
    }

    this.#counters.delete(device.id);
  }

  /** Cancellable backoff wait; `dispose()` resolves it immediately without further action. */
  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.options.clock.setTimer(ms, () => {
        this.#pendingBackoffs.delete(timer);
        resolve();
      });
      this.#pendingBackoffs.set(timer, resolve);
    });
  }
}

type ProvenanceDrift = "durable-mark-missing" | "erased" | "mark-mismatch";

/**
 * Mirrors `provenanceDrift` in doctor.ts, which is not exported and this
 * module may not edit that file. See its comment for the full reasoning on
 * `erased` / `mark-mismatch` / `durable-mark-missing`.
 */
function provenanceDrift(mark: ObservedMark): ProvenanceDrift | undefined {
  if (mark.durable === undefined) {
    return "durable-mark-missing";
  }
  if (!mark.erasableReadable) {
    return undefined;
  }
  if (mark.erasable === undefined) {
    return "erased";
  }
  return mark.erasable === mark.durable ? undefined : "mark-mismatch";
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}
