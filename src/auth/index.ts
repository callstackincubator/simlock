import type { Clock, Filesystem, IdGenerator, Logger, TokenSecrets } from "../ports/index.js";
import type { Role } from "../contract/index.js";
import type { Identity } from "./identity.js";
import { AuthError, type AuthConfig, type AuthStrategyDefinition } from "./strategy.js";
import { authStrategies } from "./strategies/index.js";
import type { TokenOperations } from "./tokens.js";

export { AuthError } from "./strategy.js";
export type {
  AuthConfig,
  AuthDeps,
  AuthRequest,
  AuthStrategy,
  AuthStrategyDefinition,
  StrategyAnswer,
} from "./strategy.js";
export type { Identity } from "./identity.js";
export type { TokenOperations, TokenRecord, TokenRole } from "./tokens.js";
export { authStrategies };

export class AdminAuthenticationFailedError extends Error {
  constructor() {
    super("Invalid admin credential");
    this.name = "AdminAuthenticationFailedError";
  }
}

export interface AuthOptions {
  readonly config: AuthConfig;
  readonly dataDirectory: string;
  readonly filesystem: Filesystem;
  readonly secrets: TokenSecrets;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type UplinkAnswer =
  | "unauthenticated"
  | "forbidden"
  | { readonly outcome: "accept"; readonly tokenId: string };

export interface Auth {
  authenticateRequest(headers: Headers): Promise<Identity>;
  resolveHelloRole(hello: {
    readonly principal?: string;
    readonly credential?: string;
  }): Promise<Role>;
  authenticateUplink(credential: string | undefined): Promise<UplinkAnswer>;
  readonly tokens: TokenOperations;
  readonly adminSecret: { persist(): Promise<void>; remove(): Promise<void> };
}

export function createAuthFrom(
  _definitions: readonly AuthStrategyDefinition[],
  options: AuthOptions,
): Auth {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    authenticateRequest: async () => {
      throw new AuthError(401, "not implemented");
    },
    resolveHelloRole: async () => "agent",
    authenticateUplink: async () => "unauthenticated",
    tokens: { create: notImplemented, list: notImplemented, revoke: notImplemented },
    adminSecret: {
      persist: () =>
        options.filesystem.writeFileAtomic(
          `${options.dataDirectory}/admin.token`,
          "unimplemented\n",
        ),
      remove: notImplemented,
    },
  };
}

export function createAuth(options: AuthOptions): Auth {
  return createAuthFrom(authStrategies, options);
}
