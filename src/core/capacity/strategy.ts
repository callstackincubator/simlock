import type { SystemStats } from "../../ports/index.js";
import type { Validator } from "../validation.js";

export type CapacityPlatform = "ios" | "android";

export interface CapacityDevice {
  readonly platform: CapacityPlatform;
  readonly state: string;
}

export type CapacityRefusalReason =
  | "device-limit"
  | "ram-budget"
  | "global-running-limit"
  | "platform-running-limit";

export interface CapacityRefusal {
  readonly ok: false;
  readonly reason: CapacityRefusalReason;
}

export type CapacityDecision = { readonly ok: true } | CapacityRefusal;

export interface RunningCapacityEntry {
  readonly running: number;
  readonly maxRunning: number;
  readonly reserved: number;
  readonly overLimit: boolean;
}

export interface RunningCapacity {
  readonly global: RunningCapacityEntry;
  readonly ios: RunningCapacityEntry;
  readonly android: RunningCapacityEntry;
}

/**
 * Decides how many devices may exist and run at once.
 *
 * Implementations are pure: every decision is taken from the snapshot and
 * reservations handed in by `CapacityCoordinator`, which owns all the stateful
 * accounting. A strategy knows nothing about queueing, device selection,
 * registry mutation, or drivers.
 */
export interface CapacityStrategy {
  /**
   * Whether another device may be created. `devices` includes synthetic entries
   * for in-flight provisioning reservations, so a strategy sees pending work as
   * though it had already landed in the registry.
   */
  canProvision(platform: CapacityPlatform, devices: readonly CapacityDevice[]): CapacityDecision;

  canReserveRunning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): CapacityDecision;

  runningCapacity(
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): RunningCapacity;

  /** Managed-device ceiling for a platform, for reporting. */
  deviceLimit(platform: CapacityPlatform): number;
}

/**
 * A strategy's registry entry: its name, how to default and validate its own
 * options block, and how to build it. Adding a strategy means adding a
 * directory and one registry line -- nothing else in the config or the
 * coordinator changes.
 */
export interface CapacityStrategyDefinition<Name extends string, Options> {
  readonly name: Name;
  defaults(systemStats: SystemStats): Options;
  readonly validator: Validator;
  create(options: Options, systemStats: SystemStats): CapacityStrategy;
}

export function defineCapacityStrategy<Name extends string, Options>(
  definition: CapacityStrategyDefinition<Name, Options>,
): CapacityStrategyDefinition<Name, Options> {
  return definition;
}
