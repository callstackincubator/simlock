import type { SystemStats } from "../../ports/index.js";
import type { Validator } from "../validation.js";

export type CapacityPlatform = "ios" | "android";

export type CapacityMode = "slim" | "full";

export interface PlannedCapacityDevice {
  readonly platform: CapacityPlatform;
  readonly mode: CapacityMode;
}

export interface CapacityDevice extends PlannedCapacityDevice {
  readonly state: string;
  readonly id?: string;
}

export type RegisteredCapacityDevice = CapacityDevice & { readonly id: string };

export interface RamBudget {
  readonly limitBytes: number;
  readonly usedBytes: number;
  readonly overLimit: boolean;
}

export type CapacityRefusalReason =
  | "device-limit"
  | "ram-budget"
  | "memory-pressure"
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
 * why: Decides how many devices may exist and run at once.
 *
 * Implementations are pure: every decision is taken from the snapshot and
 * reservations handed in by `CapacityCoordinator`, which owns all the stateful
 * accounting. A strategy knows nothing about queueing, device selection,
 * registry mutation, or drivers.
 */
export interface CapacityStrategy {
  /**
   * why: Whether `device` may be created. `devices` includes synthetic entries for
   * in-flight provisioning reservations, and counts a device being booted at its
   * full size, so a strategy sees pending work as though it had already landed in
   * the registry.
   */
  canProvision(device: PlannedCapacityDevice, devices: readonly CapacityDevice[]): CapacityDecision;

  /**
   * why: Whether the shut-down `device`, already among `devices`, may boot. A device
   * boots at its platform's full size before any slim pass. A shut-down device holds
   * no RAM, so a boot needs room for that whole size; a running one needs the difference.
   */
  canBoot(device: CapacityDevice, devices: readonly CapacityDevice[]): CapacityDecision;

  canReserveRunning(
    platform: CapacityPlatform,
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): CapacityDecision;

  runningCapacity(
    devices: readonly CapacityDevice[],
    reservations: readonly CapacityPlatform[],
  ): RunningCapacity;

  deviceLimit(platform: CapacityPlatform): number;

  ramBudget(devices: readonly CapacityDevice[]): RamBudget | undefined;
}

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
