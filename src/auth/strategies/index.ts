import type { AuthStrategyDefinition } from "../strategy.js";
import { proxyStrategy } from "./proxy-jwt/index.js";
import { tokenStrategy } from "./token/index.js";

export const authStrategies: readonly AuthStrategyDefinition[] = [tokenStrategy, proxyStrategy];
