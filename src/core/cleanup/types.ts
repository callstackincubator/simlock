import type { Config } from "../config.js";
import type { VirtualDevice, LeaseRecord } from "../domain.js";

export type CleanupAction = "shutdown" | "destroy";

export interface RegistryView {
  readonly config: Config;
  readonly devices: readonly VirtualDevice[];
  readonly diskFreeBytes: number;
  readonly leases: readonly LeaseRecord[];
  readonly now: number;
  /** why: idle shutdown must spare warm targets, learned kinds and devices serving queued demand. */
  readonly targeted: ReadonlySet<string>;
}

export interface Proposal {
  readonly action: CleanupAction;
  readonly reason: string;
  readonly rule: string;
  readonly target: string;
}

export interface CleanupRule {
  readonly name: string;
  evaluate(view: RegistryView): readonly Proposal[];
}
