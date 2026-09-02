import type { Context, MiddlewareHandler, Next } from "hono";

import { forbidden, unauthenticated } from "./errors.js";
import type { TokenIdentity, TokenRole } from "./token-store.js";

export interface AuthEnv {
  readonly Variables: {
    identity: TokenIdentity;
  };
}

export interface TokenVerifier {
  verify(secret: string): Promise<TokenIdentity | undefined>;
}

const BEARER_PREFIX = "Bearer ";

function extractSecret(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return undefined;
  const secret = header.slice(BEARER_PREFIX.length).trim();
  return secret === "" ? undefined : secret;
}

/**
 * Verifies the bearer token and stores its `TokenIdentity` on the context for downstream
 * handlers. `minRole: "operator"` rejects an `agent` token with 403 before the handler runs;
 * per-resource ownership (an agent reaching another requester's request/lease) is not a role
 * gate and is checked by the handler itself against the stored identity.
 */
export function requireAuth(
  tokens: TokenVerifier,
  minRole?: TokenRole,
): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    const secret = extractSecret(c.req.header("authorization"));
    if (secret === undefined) throw unauthenticated("Missing bearer token");

    const identity = await tokens.verify(secret);
    if (identity === undefined) throw unauthenticated("Unknown bearer token");

    if (minRole === "operator" && identity.role !== "operator") {
      throw forbidden("Operator role required");
    }

    c.set("identity", identity);
    await next();
  };
}

/** Throws 403 unless the identity owns `requesterId` or holds the operator role. */
export function requireOwnership(identity: TokenIdentity, requesterId: string): void {
  if (identity.role === "operator") return;
  if (identity.requesterId === requesterId) return;
  throw forbidden("Not permitted to access another requester's resource");
}
