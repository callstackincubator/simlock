import type { TargetKind, TargetShort } from "./policy.js";

export interface WarmTargetFigures extends TargetKind {
  readonly origin: "configured" | "learned";
  readonly imageTag?: string;
  readonly baseline?: string;
  readonly count: number;
  readonly ready: number;
  readonly booting: number;
  readonly short?: TargetShort;
}

export interface WarmPoolFigures {
  readonly enabled: boolean;
  readonly reserveRunning: { readonly ios: number; readonly android: number };
  readonly targets: readonly WarmTargetFigures[];
}
