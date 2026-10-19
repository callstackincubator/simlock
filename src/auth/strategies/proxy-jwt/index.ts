import { z } from "zod";

import type { AuthStrategyDefinition } from "../../strategy.js";

export const proxyStrategy: AuthStrategyDefinition = {
  name: "proxy",
  config: { key: "proxyAuth", schema: z.unknown(), defaults: undefined },
  enabled: () => false,
  create: () => ({
    authenticate: async () => ({ kind: "not-mine", sawCredential: false }),
  }),
};
