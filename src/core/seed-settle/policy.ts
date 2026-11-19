import type { Platform } from "../domain.js";

export const CHECK_INTERVAL_MS = 5 * 60_000;
export const QUIET_MS = 5 * 60_000;

export interface SettleCandidate {
  readonly platform: Platform;
  readonly sourceId: string;
  readonly leases: number;
  /** why: a failed settle keeps its seed out of the background until this time. */
  readonly failedUntil?: number;
}

export interface OperatorWait {
  readonly platform: Platform;
  readonly specKey: string;
}

export interface SettleView {
  readonly candidates: readonly SettleCandidate[];
  readonly operator: readonly OperatorWait[];
  readonly running: boolean;
  readonly underWay: number;
  readonly lastReleasedAt?: number;
  readonly now: number;
  readonly pressure: "none" | "warming-paused" | "new-devices-paused";
  readonly diskFreeBytes: number;
  readonly freeBytesThreshold: number;
}

export type SettleDecision =
  | {
      readonly kind: "wait";
      readonly reason:
        | "settle-running"
        | "busy"
        | "quiet"
        | "memory-pressure"
        | "disk-pressure"
        | "no-candidate";
    }
  | {
      readonly kind: "settle";
      readonly platform: Platform;
      readonly operator: boolean;
      readonly sourceId?: string;
      readonly specKey?: string;
    };

/**
 * why: ADR 0090 §2 as one pure function, so the settler holds only the mechanism. The gates come
 * first and the candidates are only looked for when they are open: a wait other than
 * `no-candidate` means the settler lists no source at all. An operator's kind goes first and
 * skips the quiet rule (ADR 0090 §4).
 */
export function nextSettle(view: SettleView): SettleDecision {
  if (view.running) return { kind: "wait", reason: "settle-running" };
  if (view.pressure !== "none") return { kind: "wait", reason: "memory-pressure" };
  if (view.diskFreeBytes < view.freeBytesThreshold)
    return { kind: "wait", reason: "disk-pressure" };
  const operator = view.operator[0];
  if (operator !== undefined) {
    return {
      kind: "settle",
      operator: true,
      platform: operator.platform,
      specKey: operator.specKey,
    };
  }
  if (view.underWay > 0) return { kind: "wait", reason: "busy" };
  if (view.lastReleasedAt !== undefined && view.now - view.lastReleasedAt < QUIET_MS) {
    return { kind: "wait", reason: "quiet" };
  }
  let best: SettleCandidate | undefined;
  for (const candidate of view.candidates) {
    if (candidate.failedUntil !== undefined && candidate.failedUntil > view.now) continue;
    if (best === undefined || candidate.leases > best.leases) best = candidate;
  }
  if (best === undefined) return { kind: "wait", reason: "no-candidate" };
  return { kind: "settle", operator: false, platform: best.platform, sourceId: best.sourceId };
}
