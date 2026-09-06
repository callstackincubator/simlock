import type { Context, MiddlewareHandler, Next } from "hono";

import { forbidden, unauthenticated } from "./errors.js";
import type { TokenIdentity } from "./token-store.js";

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
 * ADR 0003 §2: "The HTTP app becomes routing plus a bearer-token-to-session adapter". This is
 * that adapter's authentication half -- it verifies the bearer token and stores its
 * `TokenIdentity` on the context, nothing more. Role gating (what used to be this function's
 * own `minRole` parameter, 403-ing an agent token before a handler ran) and per-resource
 * ownership (what used to be the separate `requireOwnership` export) both moved to the shared
 * `Dispatcher`'s role check and `authorize` hook (see `dispatcher-session.ts`) -- the same
 * checks the socket path runs, not a second HTTP-only copy. A route still needs *an* identity
 * to build the `DispatchSession` `dispatch()` takes, which is what this middleware supplies.
 *
 * The one role decision that *does* live here is ADR 0005 §25's: a `worker`-role join token is
 * `403` on every `/v1` route. It is not a role gate of the kind that moved to the dispatcher --
 * those compare an operation's required role to a session's. This is narrower and belongs at
 * the transport: a join token authorizes one transport (the uplink upgrade, see
 * `src/ports/uplink.ts`) and no operation at all, so there is no session to build from it and
 * nothing further down the stack could tell the difference between it and an agent token.
 * Refusing it here, before a `DispatchSession` exists, is what makes "it can open an uplink and
 * nothing else" true rather than aspirational.
 */
export function requireAuth(tokens: TokenVerifier): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    const secret = extractSecret(c.req.header("authorization"));
    if (secret === undefined) throw unauthenticated("Missing bearer token");

    const identity = await tokens.verify(secret);
    if (identity === undefined) throw unauthenticated("Unknown bearer token");
    // 403, not 401: the token is real and was recognized -- it simply has no authority here
    // (ADR 0005 §25).
    if (identity.role === "worker") {
      throw forbidden("A worker join token can only open an uplink, not call the HTTP API");
    }

    c.set("identity", identity);
    await next();
  };
}
