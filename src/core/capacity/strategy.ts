import type { SystemStats } from "../../ports/index.js";
import type { Validator } from "../validation.js";

export type CapacityPlatform = "ios" | "android";

export type CapacityMode = "slim" | "full";

/** A device a strategy has yet to admit: what it will be, before it exists. */
export interface PlannedCapacityDevice {
  readonly platform: CapacityPlatform;
  readonly mode: CapacityMode;
}

export interface CapacityDevice extends PlannedCapacityDevice {
  readonly state: string;
  /** The registry id, so the coordinator can find a device it holds a boot reservation for. */
  readonly id?: string;
}

/** A capacity device the registry knows, so a boot reservation can find it again. */
export type RegisteredCapacityDevice = CapacityDevice & { readonly id: string };

/** A strategy's RAM budget as it stands: its limit, what devices use, and whether use exceeds it. */
export interface RamBudget {
  readonly limitBytes: number;
  readonly usedBytes: number;
  readonly overLimit: boolean;
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
   * Whether `device` may be created. `devices` includes synthetic entries for
   * in-flight provisioning reservations, and counts a device being booted at its
   * full size, so a strategy sees pending work as though it had already landed in
   * the registry.
   */
  canProvision(device: PlannedCapacityDevice, devices: readonly CapacityDevice[]): CapacityDecision;

  /**
   * Whether the shut-down `device`, already among `devices`, may boot. A device
   * boots at its platform's full size before any slim pass, so a boot needs room
   * for the difference between that and the size the device counts at.
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

  /** Managed-device ceiling for a platform, for reporting. */
  deviceLimit(platform: CapacityPlatform): number;

  /** The RAM budget over `devices`, or `undefined` for a strategy that keeps none. */
  ramBudget(devices: readonly CapacityDevice[]): RamBudget | undefined;
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
