import type { AuthStrategyDefinition } from "../strategy.js";
import { tokenStrategy } from "./token/index.js";

export const authStrategies: readonly AuthStrategyDefinition[] = [tokenStrategy];
