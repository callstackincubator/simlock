import type { SystemStats } from "../ports/index.js";
import {
  canProvision,
  canReserveRunning,
  runningCapacity,
  type CapacityDecision,
  type CapacityDevice,
  type CapacityPlatform,
  type RunningCapacity,
} from "./capacity.js";
import type { Config } from "./config.js";

/** A releasable capacity reservation. Releasing it more than once is safe. */
export interface CapacityReservation {
  release(): void;
}

export type CapacityReservationAttempt =
  | { readonly ok: true; readonly reservation: CapacityReservation }
  | Exclude<CapacityDecision, { readonly ok: true }>;

interface ReservationEntry {
  readonly platform: CapacityPlatform;
}

/**
 * Stateful accounting around the pure capacity functions.
 *
 * It deliberately has no knowledge of queueing, device selection, registry
 * mutation, or drivers. Callers supply a fresh registry snapshot for every
 * decision and retain reservations until their corresponding operation ends.
 */
export class CapacityCoordinator {
  readonly #provisioningReservations: ReservationEntry[] = [];
  readonly #runningReservations: ReservationEntry[] = [];

  constructor(
    private readonly config: Config,
    private readonly systemStats: SystemStats,
  ) {}

  /**
   * Reserves both a future device slot and its future running slot.
   * Provisioning counts against RAM/device limits and running limits until
   * released, including before the device appears in a registry snapshot.
   */
  tryReserveProvisioning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
  ): CapacityReservationAttempt {
    const provision = canProvision(
      platform,
      [...devices, ...this.#provisioningReservations.map(asProvisioningDevice)],
      this.config,
      this.systemStats,
    );
    if (!provision.ok) return provision;

    const running = canReserveRunning(
      platform,
      devices,
      this.#allRunningReservations(),
      this.config,
    );
    if (!running.ok) return running;

    const reservation = { platform };
    this.#provisioningReservations.push(reservation);
    return {
      ok: true,
      reservation: this.#reservation(this.#provisioningReservations, reservation),
    };
  }

  /** Reserves a running slot for booting an already registered device. */
  tryReserveRunning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
  ): CapacityReservationAttempt {
    const decision = canReserveRunning(
      platform,
      devices,
      this.#allRunningReservations(),
      this.config,
    );
    if (!decision.ok) return decision;

    const reservation = { platform };
    this.#runningReservations.push(reservation);
    return { ok: true, reservation: this.#reservation(this.#runningReservations, reservation) };
  }

  runningCapacity(devices: readonly CapacityDevice[]): RunningCapacity {
    return runningCapacity(devices, this.#allRunningReservations(), this.config);
  }

  #allRunningReservations(): CapacityPlatform[] {
    return [...this.#provisioningReservations, ...this.#runningReservations].map(
      ({ platform }) => platform,
    );
  }

  #reservation(
    reservations: ReservationEntry[],
    reservation: ReservationEntry,
  ): CapacityReservation {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const index = reservations.indexOf(reservation);
        if (index !== -1) reservations.splice(index, 1);
      },
    };
  }
}

function asProvisioningDevice(reservation: ReservationEntry): CapacityDevice {
  return { platform: reservation.platform, state: "provisioning" };
}
