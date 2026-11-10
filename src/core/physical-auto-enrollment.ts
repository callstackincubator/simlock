import type { Clock, Logger, TimerHandle } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { Config } from "./config.js";
import type { Platform } from "./domain.js";
import type { DriverCatalog } from "./driver-catalog.js";
import {
  DeviceBusyError,
  DeviceNotEnrollableError,
  type PhysicalEnrollment,
  PhysicalInspectionError,
} from "./physical-enrollment.js";
import type { RegistrySnapshot } from "./registry.js";
import { stableError } from "./stable-error.js";

interface Attachment {
  heldOut: boolean;
  missing: number;
  readonly startedAt: number;
}

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
  readonly #attachments = new Map<Platform, Map<string, Attachment>>();
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
    const startedAt = this.options.clock.now();
    for (const platform of PLATFORMS) {
      const attached = await this.options.drivers.get(platform).listAttachedPhysical();
      const attachments = this.#attachmentsOf(platform);
      this.#forgetMissing(attachments, attached);
      for (const id of attached) {
        if (this.#disposed) return;
        const attachment = attachments.get(id) ?? { heldOut: false, missing: 0, startedAt };
        attachments.set(id, attachment);
        attachment.missing = 0;
        if (this.#isHeldOut(attachment, id)) continue;
        attachment.heldOut = await this.#enrol(platform, id);
      }
    }
  }

  /**
   * why: a phone whose record went away while it stayed plugged in must not come back by itself; the
   * hold-out lasts until the phone has been off USB for `health.stableObservations` runs in a row.
   */
  #isHeldOut(attachment: Attachment, driverDeviceId: string): boolean {
    if (attachment.heldOut) return true;
    const records = this.options.registry.snapshot.devices.filter(
      (device) => device.physical && device.driverDeviceId === driverDeviceId,
    );
    const seenLive = records.some((device) => device.state !== "deleted");
    const removedSince = records.some(
      (device) => device.deletedAt !== undefined && device.deletedAt > attachment.startedAt,
    );
    attachment.heldOut = seenLive || removedSince;
    return attachment.heldOut;
  }

  #attachmentsOf(platform: Platform): Map<string, Attachment> {
    const known = this.#attachments.get(platform);
    if (known !== undefined) return known;
    const created = new Map<string, Attachment>();
    this.#attachments.set(platform, created);
    return created;
  }

  #forgetMissing(attachments: Map<string, Attachment>, attached: readonly string[]): void {
    for (const [id, attachment] of attachments) {
      if (attached.includes(id)) continue;
      attachment.missing += 1;
      if (attachment.missing >= this.options.config.health.stableObservations) {
        attachments.delete(id);
      }
    }
  }

  async #enrol(platform: Platform, id: string): Promise<boolean> {
    try {
      await this.options.enrollment.add(platform, id, { initiator: "auto" });
    } catch (error: unknown) {
      this.#refused(platform, id, error);
      return false;
    }
    this.#reasons.delete(`${platform}:${id}`);
    this.options.notifyAvailability();
    return true;
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
}
