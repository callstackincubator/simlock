export type DeviceOperation =
  | "boot"
  | "eviction"
  | "cleanup"
  | "nuke"
  | "recovery"
  | "reclaim"
  | "enrollment"
  | "grant";

export interface DeviceOperationClaim {
  readonly deviceId: string;
  readonly operation: DeviceOperation;
  readonly owner?: string | undefined;
  release(): void;
}

export class DeviceOperationClaims {
  readonly #claims = new Map<string, DeviceOperationClaim>();

  tryClaim(
    deviceId: string,
    operation: DeviceOperation,
    owner?: string,
  ): DeviceOperationClaim | undefined {
    if (this.#claims.has(deviceId)) return undefined;

    let released = false;
    const claim: DeviceOperationClaim = {
      deviceId,
      operation,
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.#claims.get(deviceId) === claim) this.#claims.delete(deviceId);
      },
    };
    this.#claims.set(deviceId, claim);
    return claim;
  }

  /** What holds `deviceId` and for whom; `undefined` when nothing does. */
  claim(deviceId: string): { readonly kind: DeviceOperation; readonly owner?: string } | undefined {
    const held = this.#claims.get(deviceId);
    if (held === undefined) return undefined;
    return { kind: held.operation, ...(held.owner === undefined ? {} : { owner: held.owner }) };
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
