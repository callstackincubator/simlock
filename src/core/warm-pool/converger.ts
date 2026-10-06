import type { EventBus } from "../../bus/index.js";
import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../../ports/index.js";
import { capacityDevice, capacityDevices, type CapacityCoordinator } from "../capacity/index.js";
import type { DeviceOperationClaims } from "../device-operation-claims.js";
import { type DeviceRecord, type LeaseRecord, type WaitingDemand } from "../domain.js";
import type { ManagedDeviceLifecycle } from "../managed-device-lifecycle.js";
import type { SerializedDecision } from "../serialized-decision.js";
import { stableError } from "../stable-error.js";
import type { WarmPoolConfig } from "./config.js";
import { evaluate, type WarmProposal } from "./policy.js";

export interface WarmPoolOptions {
  readonly acquisition: {
    kick(): void;
    /** An operator reset (`nuke`) holds acquisition closed: the pool leaves every device alone. */
    readonly maintenanceActive: boolean;
    waitingDemand(): readonly WaitingDemand[];
  };
  readonly capacity: Pick<CapacityCoordinator, "runningCapacity" | "tryReserveBoot">;
  readonly claims: Pick<DeviceOperationClaims, "isClaimed" | "operationFor" | "tryClaim">;
  readonly clock: Clock;
  readonly config: WarmPoolConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly eventBus: Pick<EventBus, "subscribe">;
  readonly idle: { readonly shutdownAfterMs: number };
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "bootWarm" | "shutdown">;
  readonly logger?: Logger;
  readonly registry: {
    readonly snapshot: {
      readonly devices: readonly DeviceRecord[];
      readonly leases: readonly LeaseRecord[];
    };
  };
}

/** The tick that re-runs a pass when no event does, so a slot freed silently is still used. */
export const WARM_POOL_TICK_MS = 30_000;

/**
 * Observes the bus and runs one pass at a time over the pool: it reads a snapshot, asks the policy
 * what to shut down and boot, and does each through the device lifecycle, revalidating the device
 * first (safety rule 2). A trigger that arrives during a pass asks for one more, not one each.
 *
 * Every action ends in `kick()`, whether it worked or not, so a request waiting on a boot the
 * pool started plans again either way.
 */
export class WarmPool {
  readonly #logger: Logger;
  readonly #unsubscribe: (() => void)[] = [];
  /** When a device whose boot or shutdown failed may be tried again, by device id. */
  readonly #retryAfter = new Map<string, number>();
  #again = false;
  #started = false;
  /** Devices shut down under an operator reset that have not left `shutdown` since. */
  readonly #reset = new Set<string>();
  #running: Promise<void> | undefined;
  #tick: TimerHandle | undefined;

  constructor(private readonly options: WarmPoolOptions) {
    this.#logger = options.logger?.child("warm-pool") ?? new NoopLogger();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const event of TRIGGERS) {
      this.#unsubscribe.push(this.options.eventBus.subscribe(event, () => this.#trigger()));
    }
    this.#armTick();
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    if (this.#tick !== undefined) this.options.clock.cancel(this.#tick);
    this.#tick = undefined;
  }

  /** Runs a pass, or joins the one running and asks for one more. Resolves when they are done. */
  pass(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    const running = this.#drain().finally(() => {
      this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  /** Resolves once no pass is running or waiting. */
  async settle(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  #trigger(): void {
    void this.pass();
  }

  #armTick(): void {
    this.#tick = this.options.clock.setTimer(WARM_POOL_TICK_MS, () => {
      this.#trigger();
      this.#armTick();
    });
  }

  async #drain(): Promise<void> {
    do {
      this.#again = false;
      await this.#once();
    } while (this.#again);
  }

  async #once(): Promise<void> {
    if (this.options.acquisition.maintenanceActive) {
      // Whatever is shut down under a reset, an iOS device its forced release left that way
      // included, is meant to stay down.
      for (const device of this.options.registry.snapshot.devices) {
        if (device.state === "shutdown") this.#reset.add(device.id);
      }
      return;
    }
    try {
      const proposals = await this.options.decisions.run(() => evaluate(this.#view()));
      for (const proposal of proposals) await this.#act(proposal);
    } catch (error: unknown) {
      this.#logger.error("a warm pool pass failed", { step: "pass", error: stableError(error) });
    }
  }

  #view(): Parameters<typeof evaluate>[0] {
    const { devices, leases } = this.options.registry.snapshot;
    for (const id of this.#reset) {
      if (devices.find((device) => device.id === id)?.state !== "shutdown") this.#reset.delete(id);
    }
    return {
      capacity: this.options.capacity.runningCapacity(capacityDevices(devices)),
      config: {
        enabled: this.options.config.enabled,
        reserveRunning: this.options.config.reserveRunning,
        shutdownAfterMs: this.options.idle.shutdownAfterMs,
      },
      devices,
      // A `ready` device under a `boot` claim is one handed to a lease, not yet granted.
      handoffInFlight: devices.some(
        (device) =>
          device.state === "ready" && this.options.claims.operationFor(device.id) === "boot",
      ),
      isClaimed: (deviceId) => this.options.claims.isClaimed(deviceId),
      leases,
      now: this.options.clock.now(),
      resetDevices: new Set(this.#reset),
      waiting: this.options.acquisition.waitingDemand(),
    };
  }

  async #act(proposal: WarmProposal): Promise<void> {
    // A failed step releases its reservation and so triggers the next pass at once; without a
    // pause that would retry a broken boot in a loop.
    if ((this.#retryAfter.get(proposal.deviceId) ?? 0) > this.options.clock.now()) return;
    if (this.options.acquisition.maintenanceActive) return;
    if (proposal.action === "shutdown") await this.#shutdown(proposal);
    else await this.#boot(proposal);
  }

  async #shutdown(proposal: WarmProposal): Promise<void> {
    const device = await this.options.decisions.run(() =>
      this.#unleased(proposal.deviceId, "ready"),
    );
    if (device === undefined) return;
    try {
      const done = await this.options.lifecycle.shutdown(device, "warm-pool", "cleanup");
      if (done === undefined) return;
    } catch (error: unknown) {
      this.#logFailure(device, "shutdown", error);
    }
    this.options.acquisition.kick();
  }

  async #boot(proposal: WarmProposal): Promise<void> {
    const held = await this.options.decisions.run(() => {
      const device = this.#unleased(proposal.deviceId, "shutdown");
      if (device === undefined) return undefined;
      const reservation = this.options.capacity.tryReserveBoot(
        capacityDevice(device),
        capacityDevices(this.options.registry.snapshot.devices),
      );
      if (!reservation.ok) return undefined;
      const claim = this.options.claims.tryClaim(device.id, "boot");
      if (claim === undefined) {
        reservation.reservation.release();
        return undefined;
      }
      return { claim, device, reservation: reservation.reservation };
    });
    if (held === undefined) return;
    try {
      const done = await this.options.lifecycle.bootWarm(held.device, held.claim);
      if (done === undefined) return;
    } catch (error: unknown) {
      this.#logFailure(held.device, "boot", error);
    } finally {
      await this.options.decisions.run(() => {
        held.claim.release();
        held.reservation.release();
      });
    }
    this.options.acquisition.kick();
  }

  /** The device, when it is still in `state`, has no lease and no operation claim on it. */
  #unleased(deviceId: string, state: DeviceRecord["state"]): DeviceRecord | undefined {
    const { devices, leases } = this.options.registry.snapshot;
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (
      device?.state !== state ||
      leases.some((lease) => lease.deviceId === deviceId) ||
      this.options.claims.isClaimed(deviceId)
    ) {
      return undefined;
    }
    return device;
  }

  #logFailure(device: DeviceRecord, step: "shutdown" | "boot", error: unknown): void {
    this.#retryAfter.set(device.id, this.options.clock.now() + WARM_POOL_TICK_MS);
    this.#logger.warn(`warm pool ${step} of a device failed`, {
      deviceId: device.id,
      step,
      error: stableError(error),
    });
  }
}

const TRIGGERS = [
  "daemon.started",
  "device.reclaimed",
  "device.quarantine-recovered",
  "lease.granted",
  "lease.released",
  "device.shutdown",
  "device.deleted",
  "cleanup.executed",
  "capacity.changed",
] as const;
