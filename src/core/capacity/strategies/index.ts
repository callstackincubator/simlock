import type { SystemStats } from "../../../ports/index.js";
import type { Validator } from "../../validation.js";
import type { CapacityStrategy, CapacityStrategyDefinition } from "../strategy.js";
import { fixedStrategy } from "./fixed/index.js";
import { resourceStrategy } from "./resource/index.js";

/**
 * The registry. Adding a strategy means adding a directory next to these and one
 * line here -- the config type, its validation, and the coordinator all follow
 * from this map.
 */
export const capacityStrategies = {
  fixed: fixedStrategy,
  resource: resourceStrategy,
} as const;

export const DEFAULT_CAPACITY_STRATEGY = "resource";

export type CapacityStrategyName = keyof typeof capacityStrategies;

export const capacityStrategyNames = Object.keys(
  capacityStrategies,
) as readonly CapacityStrategyName[];

type OptionsFor<Name extends CapacityStrategyName> =
  (typeof capacityStrategies)[Name] extends CapacityStrategyDefinition<Name, infer Options>
    ? Options
    : never;

/**
 * Discriminated on `strategy`, so a config only ever carries the options block
 * belonging to the strategy it selected.
 */
export type CapacityConfig = {
  [Name in CapacityStrategyName]: {
    readonly strategy: Name;
    readonly config: OptionsFor<Name>;
  };
}[CapacityStrategyName];

export function isCapacityStrategyName(value: unknown): value is CapacityStrategyName {
  return typeof value === "string" && value in capacityStrategies;
}

export function capacityStrategyValidator(name: CapacityStrategyName): Validator {
  return capacityStrategies[name].validator;
}

export function defaultCapacityOptions<Name extends CapacityStrategyName>(
  name: Name,
  systemStats: SystemStats,
): OptionsFor<Name> {
  return capacityStrategies[name].defaults(systemStats) as OptionsFor<Name>;
}

export function createCapacityStrategy(
  capacity: CapacityConfig,
  systemStats: SystemStats,
): CapacityStrategy {
  const definition = capacityStrategies[capacity.strategy] as CapacityStrategyDefinition<
    CapacityStrategyName,
    unknown
  >;
  return definition.create(capacity.config, systemStats);
}

export type { ResourceStrategyOptions } from "./resource/index.js";
