import type {
  CapacityDecision,
  CapacityDevice,
  CapacityPlatform,
  CapacityRefusal,
  CapacityStrategy,
  RunningCapacity,
} from "./strategy.js";

/** A releasable capacity reservation. Releasing it more than once is safe. */
export interface CapacityReservation {
  release(): void;
}

export type CapacityReservationAttempt =
  | { readonly ok: true; readonly reservation: CapacityReservation }
  | CapacityRefusal;

interface ReservationEntry {
  readonly platform: CapacityPlatform;
}

/**
 * Stateful accounting around a pure capacity strategy.
 *
 * It deliberately has no knowledge of queueing, device selection, registry
 * mutation, drivers, or of which strategy it is holding. Callers supply a fresh
 * registry snapshot for every decision and retain reservations until their
 * corresponding operation ends.
 */
export class CapacityCoordinator {
  readonly #provisioningReservations: ReservationEntry[] = [];
  readonly #runningReservations: ReservationEntry[] = [];

  constructor(private readonly strategy: CapacityStrategy) {}

  /**
   * Reserves both a future device slot and its future running slot.
   * Provisioning counts against the strategy's device budget and running limits
   * until released, including before the device appears in a registry snapshot.
   */
  tryReserveProvisioning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
  ): CapacityReservationAttempt {
    const provision = this.strategy.canProvision(platform, [
      ...devices,
      ...this.#provisioningReservations.map(asProvisioningDevice),
    ]);
    if (!provision.ok) return provision;

    const running = this.canReserveRunning(platform, devices);
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
    const decision = this.canReserveRunning(platform, devices);
    if (!decision.ok) return decision;

    const reservation = { platform };
    this.#runningReservations.push(reservation);
    return { ok: true, reservation: this.#reservation(this.#runningReservations, reservation) };
  }

  canReserveRunning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
  ): CapacityDecision {
    return this.strategy.canReserveRunning(platform, devices, this.#allRunningReservations());
  }

  runningCapacity(devices: readonly CapacityDevice[]): RunningCapacity {
    return this.strategy.runningCapacity(devices, this.#allRunningReservations());
  }

  deviceLimit(platform: CapacityPlatform): number {
    return this.strategy.deviceLimit(platform);
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
