/** Operations that must not overlap for a single device. */
export type DeviceOperation = "boot" | "eviction" | "cleanup" | "nuke";

/** An exclusive, idempotently releasable claim for one device operation. */
export interface DeviceOperationClaim {
  release(): void;
}

/**
 * Tracks exclusive per-device operations only. It intentionally contains no
 * device lifecycle, cleanup, or leasing policy.
 */
export class DeviceOperationClaims {
  readonly #claims = new Map<string, DeviceOperation>();

  tryClaim(deviceId: string, operation: DeviceOperation): DeviceOperationClaim | undefined {
    if (this.#claims.has(deviceId)) return undefined;

    this.#claims.set(deviceId, operation);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.#claims.get(deviceId) === operation) this.#claims.delete(deviceId);
      },
    };
  }

  operationFor(deviceId: string): DeviceOperation | undefined {
    return this.#claims.get(deviceId);
  }

  isClaimed(deviceId: string): boolean {
    return this.#claims.has(deviceId);
  }
}
