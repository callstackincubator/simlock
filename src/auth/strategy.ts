import type { z } from "zod";

import type { OPERATIONS } from "../contract/index.js";
import type { Clock, KeySetFetcher, Logger } from "../ports/index.js";
import type { Identity } from "./identity.js";
import type { TokenRecord } from "./tokens.js";

export type AuthConfig = z.infer<(typeof OPERATIONS)["config.get"]["output"]>["http"];

export interface AuthRequest {
  readonly headers: Headers;
}

export type StrategyAnswer =
  | { readonly kind: "identified"; readonly identity: Identity }
  | { readonly kind: "not-mine"; readonly sawCredential: boolean }
  | { readonly kind: "rejected"; readonly message: string; readonly details?: unknown }
  | { readonly kind: "forbidden"; readonly message: string };

export interface AuthStrategy {
  authenticate(request: AuthRequest): Promise<StrategyAnswer>;
}

export interface AuthDeps {
  readonly config: AuthConfig;
  readonly tokens: { verify(secret: string): Promise<TokenRecord | undefined> };
  readonly clock: Clock;
  readonly logger: Logger;
  readonly keySetFetcher: KeySetFetcher;
}

export interface AuthStrategyDefinition {
  readonly name: string;
  readonly config?: {
    readonly key: string;
    readonly schema: z.ZodType;
    readonly defaults: unknown;
  };
  enabled(config: AuthConfig): boolean;
  create(deps: AuthDeps): AuthStrategy;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
