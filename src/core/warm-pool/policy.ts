import type { DeviceRecord, LeaseRecord, WaitingDemand } from "../domain.js";
import type { RunningCapacity } from "../capacity/index.js";

/** What one pass acts on: shut a device down, or boot a shut-down one back. */
export interface WarmProposal {
  readonly action: "shutdown" | "boot";
  readonly deviceId: string;
  readonly reason: "over-budget" | "disabled" | "waiting-request" | "recently-released";
}

export interface WarmPolicyView {
  readonly devices: readonly DeviceRecord[];
  readonly leases: readonly LeaseRecord[];
  readonly waiting: readonly WaitingDemand[];
  readonly capacity: RunningCapacity;
  readonly isClaimed: (deviceId: string) => boolean;
  readonly config: { readonly enabled: boolean; readonly shutdownAfterMs: number };
  readonly now: number;
  /** A device is being handed to a lease, counted as running and as reserved until the grant. */
  readonly handoffInFlight: boolean;
}

export function evaluate(_view: WarmPolicyView): readonly WarmProposal[] {
  return [];
}
