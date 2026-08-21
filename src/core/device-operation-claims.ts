/**
 * Operations that must not overlap for a single device: booting, eviction,
 * cleanup, nuke, and the lease-scoped crash `recovery` reboot.
 */
export type DeviceOperation = "boot" | "eviction" | "cleanup" | "nuke" | "recovery";

/** An exclusive, idempotently releasable claim for one device operation. */
export interface DeviceOperationClaim {
  readonly deviceId: string;
  readonly operation: DeviceOperation;
  release(): void;
}

/**
 * Tracks exclusive per-device operations only. It intentionally contains no
 * device lifecycle, cleanup, or leasing policy.
 */
export class DeviceOperationClaims {
  readonly #claims = new Map<string, DeviceOperationClaim>();

  tryClaim(deviceId: string, operation: DeviceOperation): DeviceOperationClaim | undefined {
    if (this.#claims.has(deviceId)) return undefined;

    let released = false;
    const claim: DeviceOperationClaim = {
      deviceId,
      operation,
      release: () => {
        if (released) return;
        released = true;
        if (this.#claims.get(deviceId) === claim) this.#claims.delete(deviceId);
      },
    };
    this.#claims.set(deviceId, claim);
    return claim;
  }

  operationFor(deviceId: string): DeviceOperation | undefined {
    return this.#claims.get(deviceId)?.operation;
  }

  isClaimed(deviceId: string): boolean {
    return this.#claims.has(deviceId);
  }

  isActive(claim: DeviceOperationClaim): boolean {
    return this.#claims.get(claim.deviceId) === claim;
  }
}
