import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../ports/index.js";
import {
  type AbsentReason,
  type Config,
  type DeviceOperationClaims,
  type DriverCatalog,
  type PhysicalDevice,
  type PhysicalRead,
  type Platform,
  readPhysicalPresenceDetail,
  type Registry,
  type SerializedDecision,
  stableError,
} from "../core/index.js";

export interface PhysicalWatcherReleaser {
  admit<Result>(work: () => Promise<Result>): Promise<Result>;
  endForAbsentDevice(
    leaseId: string,
    absentReason: AbsentReason,
    proceed: () => boolean,
  ): Promise<boolean>;
  reclaimReturned(
    deviceId: string,
    osVersion: string | undefined,
    proceed: () => boolean,
  ): Promise<boolean>;
}

export interface PhysicalDeviceWatcherOptions {
  readonly claims: Pick<DeviceOperationClaims, "isClaimed">;
  readonly clock: Clock;
  readonly config: Pick<Config, "health">;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: Pick<DriverCatalog, "get">;
  readonly kick: () => void;
  readonly logger?: Logger | undefined;
  readonly registry: Pick<Registry, "snapshot" | "transitionDevice" | "rewriteAbsentReason">;
  readonly releaser: PhysicalWatcherReleaser;
}

const NOT_PRESENT: PhysicalRead = { present: false, reason: "not-present" };

export class PhysicalDeviceWatcher {
  readonly #counts = new Map<string, number>();
  readonly #generations = new Map<string, number>();
  readonly #interrupted = new Set<string>();
  readonly #logger: Logger;
  #disposed = false;
  #running: Promise<void> = Promise.resolve();
  #timer: TimerHandle | undefined;

  constructor(private readonly options: PhysicalDeviceWatcherOptions) {
    this.#logger = options.logger?.child("physical-device-watcher") ?? new NoopLogger();
  }

  /** why: not armed by the constructor: the daemon starts it once startup convergence has finished. */
  start(): void {
    if (this.#timer !== undefined) return;
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

  /**
   * why: notes the physical devices a killed daemon left `reclaiming`, once leasing's startup step has
   * run. Only these are reclaimed without a state write: a device that entered `reclaiming` in
   * this process is under its own release, or has none and is doctor's.
   */
  recordInterrupted(): void {
    for (const device of this.#enrolled()) {
      if (device.state === "reclaiming") this.#interrupted.add(device.id);
    }
  }

  /**
   * why: a physical device was just committed `ready`: its not-present reads start again from zero, and
   * a read still in flight, begun before this, no longer counts for it.
   */
  reset(deviceId: string): void {
    this.#counts.delete(deviceId);
    this.#generations.set(deviceId, this.#generation(deviceId) + 1);
  }

  #arm(): void {
    if (this.#disposed) return;
    this.#timer = this.options.clock.setTimer(this.options.config.health.probeIntervalMs, () => {
      this.#timer = undefined;
      this.#running = this.#tick()
        .catch((error: unknown) => {
          this.#logger.error("physical device watcher tick failed", { error: stableError(error) });
        })
        .finally(() => this.#arm());
    });
  }

  readonly #live = (): boolean => !this.#disposed;

  #generation(deviceId: string): number {
    return this.#generations.get(deviceId) ?? 0;
  }

  #enrolled(): PhysicalDevice[] {
    return this.options.registry.snapshot.devices.filter(
      (device): device is PhysicalDevice => device.physical && device.state !== "deleted",
    );
  }

  async #tick(): Promise<void> {
    const enrolled = this.#enrolled();
    this.#forget(enrolled);
    const leaseIds = new Map(
      this.options.registry.snapshot.leases.map((lease) => [lease.deviceId, lease.id]),
    );
    const platforms = new Set<Platform>(enrolled.map((device) => device.spec.platform));
    for (const platform of platforms) {
      const group = enrolled.filter((device) => device.spec.platform === platform);
      const before = new Map(group.map((device) => [device.id, this.#generation(device.id)]));
      const reads = await this.#read(platform, group);
      if (this.#disposed) return;
      if (reads === undefined) continue;
      for (const device of group) {
        try {
          await this.#observe(
            device,
            reads.get(device.driverDeviceId) ?? NOT_PRESENT,
            before.get(device.id) === this.#generation(device.id),
            leaseIds.get(device.id),
          );
        } catch (error: unknown) {
          this.#logger.warn("physical device action failed", {
            deviceId: device.id,
            error: stableError(error),
          });
        }
        if (this.#disposed) return;
      }
    }
  }

  async #read(
    platform: Platform,
    group: readonly PhysicalDevice[],
  ): Promise<ReadonlyMap<string, PhysicalRead> | undefined> {
    try {
      const driver = this.options.drivers.get(platform);
      return await readPhysicalPresenceDetail(
        driver,
        group.map((device) => device.driverDeviceId),
      );
    } catch (error: unknown) {
      this.#logger.warn("physical presence read failed", { platform, error: stableError(error) });
      return undefined;
    }
  }

  #forget(enrolled: readonly PhysicalDevice[]): void {
    const reclaiming = new Set(
      enrolled.filter((device) => device.state === "reclaiming").map((device) => device.id),
    );
    for (const id of this.#interrupted) {
      if (!reclaiming.has(id)) this.#interrupted.delete(id);
    }
  }

  async #observe(
    device: PhysicalDevice,
    read: PhysicalRead,
    readIsCurrent: boolean,
    leaseId: string | undefined,
  ): Promise<void> {
    if (read.present) {
      await this.#present(device, read);
      return;
    }
    if (device.state === "ready" || device.state === "leased") {
      if (readIsCurrent) await this.#missed(device, read.reason, leaseId);
      return;
    }
    if (device.state === "absent" && read.reason !== device.absentReason) {
      await this.#rewriteReason(device, read.reason);
    }
  }

  async #present(device: PhysicalDevice, read: PhysicalRead & { present: true }): Promise<void> {
    const missed = (this.#counts.get(device.id) ?? 0) > 0;
    this.#counts.delete(device.id);
    if (device.state === "ready" && missed) this.options.kick();
    if (device.state === "absent") {
      await this.options.releaser.reclaimReturned(
        device.id,
        read.osVersion ?? device.spec.osVersion,
        this.#live,
      );
    } else if (this.#interrupted.has(device.id)) {
      await this.options.releaser.reclaimReturned(device.id, undefined, this.#live);
    }
  }

  async #missed(
    device: PhysicalDevice,
    absentReason: AbsentReason,
    leaseId: string | undefined,
  ): Promise<void> {
    const count = (this.#counts.get(device.id) ?? 0) + 1;
    this.#counts.set(device.id, count);
    if (count < this.options.config.health.stableObservations) return;
    if (device.state === "leased") await this.#endLease(leaseId, absentReason);
    else await this.#markAbsent(device, absentReason);
  }

  async #endLease(leaseId: string | undefined, absentReason: AbsentReason): Promise<void> {
    if (leaseId === undefined) return;
    await this.options.releaser.endForAbsentDevice(leaseId, absentReason, this.#live);
  }

  /** why: written only if the device is still `ready` and nothing else holds it. */
  async #markAbsent(device: PhysicalDevice, absentReason: AbsentReason): Promise<void> {
    await this.options.releaser.admit(() =>
      this.options.decisions.run(async () => {
        if (this.#disposed || !this.#unclaimedIn(device.id, "ready")) return;
        await this.options.registry.transitionDevice(
          device.id,
          "absent",
          {
            event: "device.absence-detected",
            payload: { absentReason, deviceId: device.id, previousState: "ready" },
          },
          { absentReason },
        );
      }),
    );
  }

  async #rewriteReason(device: PhysicalDevice, absentReason: AbsentReason): Promise<void> {
    await this.options.releaser.admit(() =>
      this.options.decisions.run(async () => {
        if (this.#disposed || !this.#unclaimedIn(device.id, "absent")) return;
        await this.options.registry.rewriteAbsentReason(device.id, absentReason);
      }),
    );
  }

  #unclaimedIn(deviceId: string, state: PhysicalDevice["state"]): boolean {
    const current = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === deviceId,
    );
    return current?.state === state && !this.options.claims.isClaimed(deviceId);
  }
}
