import { type Auth, type AuthOptions, createAuthFrom } from "./index.js";
import type { Identity } from "./identity.js";
import { AuthError, type AuthStrategyDefinition } from "./strategy.js";

export function createAuthWith(
  definitions: readonly AuthStrategyDefinition[],
  options: AuthOptions,
): Auth {
  return createAuthFrom(definitions, options);
}

export function fakeAuth(identities: ReadonlyMap<string, Identity>): Auth {
  const unused = async (): Promise<never> => {
    throw new Error("fakeAuth only authenticates requests");
  };
  return {
    authenticateRequest: async (headers) => {
      const value = headers.get("authorization");
      const secret = value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
      if (secret === "") throw new AuthError(401, "Missing bearer token");
      const identity = identities.get(secret);
      if (identity === undefined) throw new AuthError(401, "Unknown bearer token");
      return identity;
    },
    resolveHelloRole: unused,
    authenticateUplink: unused,
    tokens: { create: unused, list: unused, revoke: unused },
    adminSecret: { persist: unused, remove: unused },
  };
}

export function tokenIdentity(principal: string, role: Identity["role"] = "agent"): Identity {
  return { principal, name: principal, role, via: "token", ambient: false };
}
