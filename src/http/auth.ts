import type { Context, MiddlewareHandler, Next } from "hono";

import { unauthenticated } from "./errors.js";
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
 */
export function requireAuth(tokens: TokenVerifier): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    const secret = extractSecret(c.req.header("authorization"));
    if (secret === undefined) throw unauthenticated("Missing bearer token");

    const identity = await tokens.verify(secret);
    if (identity === undefined) throw unauthenticated("Unknown bearer token");

    c.set("identity", identity);
    await next();
  };
}
