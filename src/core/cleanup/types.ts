import type { Config } from "../config.js";
import type { DeviceRecord, LeaseRecord } from "../domain.js";

export type CleanupAction = "shutdown" | "destroy" | "gc-runtime";

export interface RegistryView {
  readonly config: Config;
  readonly devices: readonly DeviceRecord[];
  readonly diskFreeBytes: number;
  readonly leases: readonly LeaseRecord[];
  readonly now: number;
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
