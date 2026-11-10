import type { Clock, Logger, TimerHandle } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { Config } from "./config.js";
import type { PhysicalDevice, Platform } from "./domain.js";
import type { DriverCatalog } from "./driver-catalog.js";
import {
  DeviceBusyError,
  DeviceNotEnrollableError,
  type PhysicalEnrollment,
  PhysicalInspectionError,
} from "./physical-enrollment.js";
import type { RegistrySnapshot } from "./registry.js";
import { stableError } from "./stable-error.js";

const PLATFORMS: readonly Platform[] = ["ios", "android"];

export interface PhysicalAutoEnrollmentOptions {
  readonly clock: Clock;
  readonly config: Pick<Config, "devices" | "health">;
  readonly drivers: Pick<DriverCatalog, "get">;
  readonly enrollment: Pick<PhysicalEnrollment, "add">;
  readonly logger?: Logger | undefined;
  readonly notifyAvailability: () => void;
  readonly registry: { readonly snapshot: Pick<RegistrySnapshot, "devices"> };
}

/**
 * why: a worker with `devices.autoEnroll` enrols every phone plugged in by USB through `device add`'s own
 * enrolment (ADR 0073), so an operator need not run a command per phone.
 */
export class PhysicalAutoEnrollment {
  readonly #logger: Logger;
  readonly #reasons = new Map<string, string>();
  #disposed = false;
  #running: Promise<void> = Promise.resolve();
  #timer: TimerHandle | undefined;

  constructor(private readonly options: PhysicalAutoEnrollmentOptions) {
    this.#logger = options.logger?.child("auto-enroll") ?? new NoopLogger();
  }

  /** why: not armed by the constructor: the daemon starts it once startup convergence has finished. */
  start(): void {
    if (!this.options.config.devices.autoEnroll || this.#timer !== undefined) return;
    this.#arm();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) this.options.clock.cancel(this.#timer);
    this.#timer = undefined;
  }

  async settle(): Promise<void> {
    await this.#running;
  }

  #arm(): void {
    if (this.#disposed) return;
    this.#timer = this.options.clock.setTimer(this.options.config.health.probeIntervalMs, () => {
      this.#timer = undefined;
      this.#running = this.#tick()
        .catch((error: unknown) => {
          this.#logger.error("auto-enroll run failed", { error: stableError(error) });
        })
        .finally(() => this.#arm());
    });
  }

  async #tick(): Promise<void> {
    for (const platform of PLATFORMS) {
      const attached = await this.options.drivers.get(platform).listAttachedPhysical();
      for (const id of attached) {
        if (this.#disposed) return;
        if (this.#hasLiveRecord(id)) continue;
        await this.#enrol(platform, id);
      }
    }
  }

  async #enrol(platform: Platform, id: string): Promise<void> {
    try {
      await this.options.enrollment.add(platform, id, { initiator: "auto" });
    } catch (error: unknown) {
      this.#refused(platform, id, error);
      return;
    }
    this.#reasons.delete(`${platform}:${id}`);
    this.options.notifyAvailability();
  }

  /** why: a refusal is logged once per reason, so a locked phone does not fill the log every interval. */
  #refused(platform: Platform, id: string, error: unknown): void {
    if (error instanceof DeviceBusyError) return;
    const reason =
      error instanceof DeviceNotEnrollableError
        ? error.reason
        : error instanceof PhysicalInspectionError
          ? "unreadable"
          : undefined;
    if (reason === undefined) throw error;
    const key = `${platform}:${id}`;
    if (this.#reasons.get(key) === reason) return;
    this.#reasons.set(key, reason);
    this.#logger.warn(`auto-enroll: ${platform} ${id} not enrolled: ${(error as Error).message}`);
  }

  #hasLiveRecord(driverDeviceId: string): boolean {
    return this.options.registry.snapshot.devices.some(
      (device): device is PhysicalDevice =>
        device.physical && device.state !== "deleted" && device.driverDeviceId === driverDeviceId,
    );
  }
}
