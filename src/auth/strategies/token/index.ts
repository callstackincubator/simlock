import type { AuthStrategyDefinition } from "../../strategy.js";

export const tokenStrategy: AuthStrategyDefinition = {
  name: "token",
  enabled: () => true,
  create: () => ({
    authenticate: async () => ({ kind: "rejected", message: "not implemented" }),
  }),
};
