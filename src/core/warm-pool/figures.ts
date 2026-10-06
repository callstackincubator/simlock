import type { TargetKind, TargetShort } from "./policy.js";

/** One warm target as `status` reports it: its kind, how many it wants, and how it stands. */
export interface WarmTargetFigures extends TargetKind {
  readonly count: number;
  readonly ready: number;
  readonly booting: number;
  /** Why the last pass could do nothing for it; absent when it is filled, filling or waiting. */
  readonly short?: TargetShort;
}

/** The warm pool as the last pass left it. */
export interface WarmPoolFigures {
  readonly enabled: boolean;
  readonly reserveRunning: { readonly ios: number; readonly android: number };
  readonly targets: readonly WarmTargetFigures[];
}
