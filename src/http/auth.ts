import type { Context, MiddlewareHandler, Next } from "hono";

import { type Auth, AuthError, type Identity } from "../auth/index.js";
import { HttpApiError } from "./errors.js";

export interface AuthEnv {
  readonly Variables: {
    identity: Identity;
  };
}

export function requireAuth(auth: Pick<Auth, "authenticateRequest">): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    try {
      c.set("identity", await auth.authenticateRequest(c.req.raw.headers));
    } catch (error: unknown) {
      if (!(error instanceof AuthError)) throw error;
      throw new HttpApiError(
        error.status,
        error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
        error.message,
        error.details === undefined
          ? undefined
          : { details: error.details, ...reasonOf(error.details) },
      );
    }
    refuseCrossSiteChange(c);
    await next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuseCrossSiteChange(c: Context<AuthEnv>): void {
  if (!c.get("identity").ambient || SAFE_METHODS.has(c.req.method)) return;
  if (c.req.header("sec-fetch-site") === "same-origin") return;
  throw new HttpApiError(
    403,
    "FORBIDDEN",
    "Cross-site request refused: a request signed in through a sign-in proxy must come from the console",
  );
}

function reasonOf(details: unknown): { reason?: string } {
  const reason = (details as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? { reason } : {};
}
