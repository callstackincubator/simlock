import { errors, jwtVerify } from "jose";
import { z } from "zod";

import type { Identity } from "../../identity.js";
import type { AuthStrategyDefinition, StrategyAnswer } from "../../strategy.js";
import { KeyCache, type KeySet, KeysUnavailableError } from "./key-cache.js";

const HEADER_MAX_LENGTH = 8 * 1024;
const SUB_MAX_LENGTH = 120;
const CLOCK_TOLERANCE_SECONDS = 60;
const EXPIRY_GRACE_MS = 60_000;
const BEARER_PREFIX = "Bearer ";
const TOKEN_PREFIX = "slk_";
const SET_TOGETHER = "set with the other http.proxyAuth keys";

type Reason =
  | "expired"
  | "wrong-issuer"
  | "wrong-audience"
  | "not-yet-valid"
  | "algorithm"
  | "unknown-key"
  | "bad-signature"
  | "keys-unavailable"
  | "malformed";

function required(message: string) {
  return { required_error: SET_TOGETHER, invalid_type_error: message };
}

function isKeyUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// why: each message is the text after "expected" in the config error, so core/config.ts prints it as written.
export const proxyAuthSchema = z.object({
  header: z
    .string(required("an HTTP header name"))
    .regex(/^[A-Za-z0-9-]{1,64}$/, "an HTTP header name"),
  jwksUrl: z
    .string(required("an https:// URL, or http:// on 127.0.0.1, ::1 or localhost"))
    .refine(isKeyUrl, "an https:// URL, or http:// on 127.0.0.1, ::1 or localhost"),
  issuer: z
    .string(required("at most 128 characters"))
    .min(1, "a non-empty string")
    .max(128, "at most 128 characters"),
  audience: z
    .string(required("at most 512 characters"))
    .min(1, "a non-empty string")
    .max(512, "at most 512 characters"),
  signOutUrl: z
    .string({ invalid_type_error: "an http:// or https:// URL" })
    .refine(isWebUrl, "an http:// or https:// URL")
    .optional(),
});

function credentialIn(headers: Headers, header: string): string | undefined {
  const value = headers.get(header);
  if (value === null) return undefined;
  if (header !== "authorization") return value.trim();
  if (!value.startsWith(BEARER_PREFIX)) return undefined;
  const secret = value.slice(BEARER_PREFIX.length).trim();
  return secret.startsWith(TOKEN_PREFIX) ? undefined : secret;
}

function reasonOf(error: unknown): Reason {
  if (error instanceof KeysUnavailableError) return "keys-unavailable";
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return "wrong-issuer";
    if (error.claim === "aud") return "wrong-audience";
    if (error.claim === "nbf") return "not-yet-valid";
    return "malformed";
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return "algorithm";
  if (error instanceof errors.JWKSNoMatchingKey) return "unknown-key";
  if (error instanceof errors.JWSSignatureVerificationFailed) return "bad-signature";
  return "malformed";
}

export const proxyStrategy: AuthStrategyDefinition = {
  name: "proxy",
  config: { key: "proxyAuth", schema: proxyAuthSchema, defaults: undefined },
  enabled: (config) => config.proxyAuth !== undefined,
  create: (deps) => {
    const settings = deps.config.proxyAuth;
    if (settings === undefined) {
      throw new Error("The proxy strategy is created only when http.proxyAuth is set");
    }
    const header = settings.header.toLowerCase();
    const cache = new KeyCache({
      clock: deps.clock,
      fetcher: deps.keySetFetcher,
      url: settings.jwksUrl,
    });

    const refuse = (reason: Reason, detail: string): StrategyAnswer => {
      deps.logger.warn("Sign-in proxy identity refused", { reason, detail });
      return {
        kind: "rejected",
        message: `Sign-in proxy identity refused: ${reason}`,
        details: { reason },
      };
    };

    const verify = async (jwt: string, keySet: KeySet) =>
      jwtVerify(jwt, keySet, {
        algorithms: ["RS256", "ES256"],
        issuer: settings.issuer,
        audience: settings.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(deps.clock.now()),
        requiredClaims: ["exp"],
      });

    const verifyWithRefetch = async (jwt: string) => {
      const keySet = await cache.current();
      try {
        return await verify(jwt, keySet);
      } catch (error) {
        if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
        const fresh = await cache.refreshed();
        if (fresh === undefined) throw error;
        return verify(jwt, fresh);
      }
    };

    return {
      authenticate: async ({ headers }) => {
        const jwt = credentialIn(headers, header);
        if (jwt === undefined) return { kind: "not-mine", sawCredential: false };
        if (jwt.length > HEADER_MAX_LENGTH) return refuse("malformed", "credential is over 8 KiB");

        let payload;
        try {
          ({ payload } = await verifyWithRefetch(jwt));
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown error";
          return refuse(reasonOf(error), detail);
        }

        const { sub, email, iss, exp } = payload;
        if (typeof sub === "string" && sub.length > SUB_MAX_LENGTH) {
          return refuse("malformed", "sub is over 120 characters");
        }
        if (typeof sub !== "string" || sub === "")
          return { kind: "not-mine", sawCredential: false };
        if (typeof email !== "string" || email === "") {
          return { kind: "not-mine", sawCredential: false };
        }
        const claimedName: unknown = payload["name"];
        const identity: Identity = {
          principal: `proxy:${iss ?? settings.issuer}#${sub}`,
          name: typeof claimedName === "string" && claimedName !== "" ? claimedName : email,
          role: "operator",
          via: "proxy",
          expiresAt: (exp ?? 0) * 1000 + EXPIRY_GRACE_MS,
          ambient: true,
          ...(settings.signOutUrl === undefined ? {} : { signOutUrl: settings.signOutUrl }),
        };
        return { kind: "identified", identity };
      },
    };
  },
};
