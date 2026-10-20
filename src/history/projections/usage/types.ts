export interface RequestRow {
  readonly requestId: string;
  readonly requester: string;
  readonly platform: string;
  readonly model?: string;
  readonly workerId?: string;
  readonly requestedAt: number;
  readonly grantedAt?: number;
  readonly rejectedAt?: number;
  readonly reason?: string;
  readonly source?: string;
  readonly leaseId?: string;
  readonly workerLeaseId?: string;
  readonly heldMs?: number;
  readonly endedAt?: number;
  readonly endReason?: "explicit" | "killed" | "device-lost" | "expired";
  readonly probe: boolean;
  readonly declined?: true;
  readonly refusedAtAdmission?: true;
}

export const USAGE_VALUES = [
  "leasesHeld",
  "slotsUsed",
  "slotsMax",
  "ramUsedBytes",
  "ramLimitBytes",
  "queueDepth",
  "waiting",
] as const;

export type UsageValue = (typeof USAGE_VALUES)[number];

export interface BucketFigure {
  readonly peak: number;
  readonly integral: number;
}

export type MinuteBucket = {
  readonly start: number;
  readonly knownMs: number;
} & { readonly [Value in UsageValue]?: BucketFigure };

export interface DeviceFactRow {
  readonly at: number;
  readonly kind: string;
  readonly durationMs?: number;
  readonly platform?: string;
  readonly workerId?: string;
  readonly deviceId?: string;
}

export interface UsageReads {
  oldestTs(): number | undefined;
  requestRows(range: { readonly from: number; readonly to: number }): RequestRow[];
  minuteBuckets(query: {
    readonly from: number;
    readonly to: number;
    readonly bucketMs: number;
    readonly workerId: string;
    readonly platform: string;
  }): MinuteBucket[];
  deviceFacts(range: { readonly from: number; readonly to: number }): DeviceFactRow[];
}

export const MINUTE_MS = 60_000;

export function minuteOf(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}
