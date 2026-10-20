import type { AuthStrategyDefinition } from "../../strategy.js";

const BEARER_PREFIX = "Bearer ";
const TOKEN_PREFIX = "slk_";

const WORKER_TOKEN_REFUSAL = "A worker join token can only open an uplink, not call the HTTP API";

function bearerValue(header: string | null): string {
  if (header === null || !header.startsWith(BEARER_PREFIX)) return "";
  return header.slice(BEARER_PREFIX.length).trim();
}

export const tokenStrategy: AuthStrategyDefinition = {
  name: "token",
  enabled: () => true,
  create: (deps) => ({
    authenticate: async ({ headers }) => {
      const secret = bearerValue(headers.get("authorization"));
      if (!secret.startsWith(TOKEN_PREFIX)) {
        return { kind: "not-mine", sawCredential: secret !== "" };
      }

      const record = await deps.tokens.verify(secret);
      if (record === undefined) return { kind: "rejected", message: "Unknown bearer token" };
      // why: 403, not 401 -- the token is real and recognized, it just has no authority here (ADR 0005 §25).
      if (record.role === "worker") return { kind: "forbidden", message: WORKER_TOKEN_REFUSAL };

      return {
        kind: "identified",
        identity: {
          principal: record.id,
          name: record.label ?? record.id,
          role: record.role,
          via: "token",
          ambient: false,
        },
      };
    },
  }),
};
