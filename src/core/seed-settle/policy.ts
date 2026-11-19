import type { Platform } from "../domain.js";

export const CHECK_INTERVAL_MS = 5 * 60_000;
export const QUIET_MS = 5 * 60_000;

export interface SettleCandidate {
  readonly platform: Platform;
  readonly sourceId: string;
  readonly leases: number;
}

export interface SettleView {
  readonly candidates: readonly SettleCandidate[];
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
      readonly reason: "busy" | "quiet" | "memory-pressure" | "disk-pressure" | "no-candidate";
    }
  | { readonly kind: "settle"; readonly platform: Platform; readonly sourceId: string };

/**
 * why: ADR 0090 §2 as one pure function, so the settler holds only the mechanism. The gates come
 * first and the candidates are only looked for when they are open: a wait other than
 * `no-candidate` means the settler lists no source at all.
 */
export function nextSettle(view: SettleView): SettleDecision {
  if (view.pressure !== "none") return { kind: "wait", reason: "memory-pressure" };
  if (view.diskFreeBytes < view.freeBytesThreshold)
    return { kind: "wait", reason: "disk-pressure" };
  if (view.underWay > 0) return { kind: "wait", reason: "busy" };
  if (view.lastReleasedAt !== undefined && view.now - view.lastReleasedAt < QUIET_MS) {
    return { kind: "wait", reason: "quiet" };
  }
  let best: SettleCandidate | undefined;
  for (const candidate of view.candidates) {
    if (best === undefined || candidate.leases > best.leases) best = candidate;
  }
  if (best === undefined) return { kind: "wait", reason: "no-candidate" };
  return { kind: "settle", platform: best.platform, sourceId: best.sourceId };
}
