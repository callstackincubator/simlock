import type {
  DeviceRequest,
  DeviceSpec,
  LeaseGrant,
  LeaseRecord,
  Platform,
} from "../core/index.js";
import type { WaitingRequest } from "./lease-request-book.js";
import type { LeaseReleaseReason } from "./lease-release-coordinator.js";
import type { LeaseRequestOptions } from "./wait-queue.js";

export type ClientReleaseReason = Exclude<LeaseReleaseReason, "device-lost">;

export interface LeaseCommands {
  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant>;
  release(leaseId: string, reason: ClientReleaseReason): Promise<void>;
  releaseAll(reason: ClientReleaseReason): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
}

export interface QueueControl {
  readonly queueDepth: number;
  readonly physicalQueueDepth: number;
  cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable">;
  pendingRequestOwner(requesterId: string, platform?: Platform): string | undefined;
  waitingRequests(): readonly WaitingRequest[];
}

export interface EndedLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly platform: Platform;
  readonly reason: "explicit" | "killed" | "expired" | "device-lost";
}

export interface LeaseEndParticipant {
  leaseEnded(ended: EndedLease, signal: AbortSignal): Promise<void>;
}

export interface DeviceModeReader {
  servesDefaultMode(spec: DeviceSpec): boolean;
}
