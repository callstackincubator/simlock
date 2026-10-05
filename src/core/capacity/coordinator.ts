import type {
  CapacityDecision,
  CapacityDevice,
  CapacityPlatform,
  CapacityRefusal,
  CapacityStrategy,
  PlannedCapacityDevice,
  RamBudget,
  RegisteredCapacityDevice,
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

/** A provisioning reservation holds the size of the mode it was planned with until released. */
type ProvisioningEntry = PlannedCapacityDevice;

/** A shut-down device being booted, by registry id. It counts at its full size until released. */
interface BootEntry {
  readonly deviceId: string;
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
  readonly #provisioningReservations: ProvisioningEntry[] = [];
  readonly #runningReservations: ReservationEntry[] = [];
  readonly #bootReservations: BootEntry[] = [];

  /**
   * `onReservationsChanged` is called after a reservation is taken and after one is released, so
   * an observer can read the figures that change with them.
   */
  constructor(
    private readonly strategy: CapacityStrategy,
    private readonly onReservationsChanged: () => void = () => undefined,
  ) {}

  /**
   * Reserves both a future device slot and its future running slot.
   * Provisioning counts against the strategy's device budget and running limits
   * until released, including before the device appears in a registry snapshot.
   */
  tryReserveProvisioning(
    device: PlannedCapacityDevice,
    devices: readonly CapacityDevice[],
  ): CapacityReservationAttempt {
    const provision = this.canProvision(device, devices);
    if (!provision.ok) return provision;

    const running = this.canReserveRunning(device.platform, devices);
    if (!running.ok) return running;

    const reservation: ProvisioningEntry = { mode: device.mode, platform: device.platform };
    this.#provisioningReservations.push(reservation);
    return {
      ok: true,
      reservation: this.#reservation(this.#provisioningReservations, reservation),
    };
  }

  /**
   * Reserves a running slot and the RAM to boot the shut-down `device`. The RAM
   * is checked first. Until released, the device counts at its full size in every
   * decision, because it boots full before any slim pass.
   */
  tryReserveBoot(
    device: RegisteredCapacityDevice,
    devices: readonly CapacityDevice[],
  ): CapacityReservationAttempt {
    const boot = this.canBoot(device, devices);
    if (!boot.ok) return boot;
    const running = this.canReserveRunning(device.platform, devices);
    if (!running.ok) return running;

    const runningEntry = { platform: device.platform };
    this.#runningReservations.push(runningEntry);
    const bootEntry = { deviceId: device.id };
    this.#bootReservations.push(bootEntry);
    const releaseRunning = this.#reservation(this.#runningReservations, runningEntry);
    const releaseBoot = this.#reservation(this.#bootReservations, bootEntry);
    return {
      ok: true,
      reservation: {
        release: () => {
          releaseRunning.release();
          releaseBoot.release();
        },
      },
    };
  }

  /**
   * Reserves the RAM to boot a reclaimed `device` back to warm. It already holds
   * its running slot, so only the RAM is checked and held.
   */
  tryReserveRewarm(
    device: RegisteredCapacityDevice,
    devices: readonly CapacityDevice[],
  ): CapacityReservationAttempt {
    const boot = this.canBoot(device, devices);
    if (!boot.ok) return boot;

    const bootEntry = { deviceId: device.id };
    this.#bootReservations.push(bootEntry);
    return { ok: true, reservation: this.#reservation(this.#bootReservations, bootEntry) };
  }

  /**
   * Whether `device` may be created, read-only. The one question `tryReserveProvisioning` asks
   * before it reserves, and the one `atRamBudget` reads, so what status reports and what the
   * planner does cannot disagree.
   */
  canProvision(
    device: PlannedCapacityDevice,
    devices: readonly CapacityDevice[],
  ): CapacityDecision {
    return this.strategy.canProvision(device, this.#withReservations(devices));
  }

  /** Whether creating one more full device of `platform` would be refused for RAM. */
  atRamBudget(platform: CapacityPlatform, devices: readonly CapacityDevice[]): boolean {
    const decision = this.canProvision({ mode: "full", platform }, devices);
    return !decision.ok && decision.reason === "ram-budget";
  }

  canBoot(device: CapacityDevice, devices: readonly CapacityDevice[]): CapacityDecision {
    return this.strategy.canBoot(device, this.#withReservations(devices));
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

  /**
   * The RAM budget over `devices` alone: in-flight provisioning and boot
   * reservations are left out, so the use reported equals what the listed devices
   * add up to.
   */
  ramBudget(devices: readonly CapacityDevice[]): RamBudget | undefined {
    return this.strategy.ramBudget(devices);
  }

  /** `devices` as every RAM decision sees them: booting devices at full, plus pending ones. */
  #withReservations(devices: readonly CapacityDevice[]): CapacityDevice[] {
    const booting = new Set(this.#bootReservations.map(({ deviceId }) => deviceId));
    return [
      ...devices.map((device) =>
        device.id !== undefined && booting.has(device.id)
          ? { ...device, mode: "full" as const }
          : device,
      ),
      ...this.#provisioningReservations.map(asProvisioningDevice),
    ];
  }

  #allRunningReservations(): CapacityPlatform[] {
    return [...this.#provisioningReservations, ...this.#runningReservations].map(
      ({ platform }) => platform,
    );
  }

  /** Wraps an entry already pushed onto `reservations`; reports the taking, and each release. */
  #reservation<Entry>(reservations: Entry[], reservation: Entry): CapacityReservation {
    let released = false;
    this.onReservationsChanged();
    return {
      release: () => {
        if (released) return;
        released = true;
        const index = reservations.indexOf(reservation);
        if (index !== -1) reservations.splice(index, 1);
        this.onReservationsChanged();
      },
    };
  }
}

function asProvisioningDevice(reservation: ProvisioningEntry): CapacityDevice {
  return { mode: reservation.mode, platform: reservation.platform, state: "provisioning" };
}
