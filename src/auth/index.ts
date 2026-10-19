import { join } from "node:path";

import type {
  Clock,
  Filesystem,
  IdGenerator,
  KeySetFetcher,
  Logger,
  TokenSecrets,
} from "../ports/index.js";
import type { Role } from "../contract/index.js";
import type { Identity } from "./identity.js";
import { AuthError, type AuthConfig, type AuthStrategyDefinition } from "./strategy.js";
import { authStrategies } from "./strategies/index.js";
import { AdminSecretManager } from "./admin-secret.js";
import { AdminAuthenticationFailedError } from "./hello.js";
import { TokenStore } from "./token-store.js";
import type { TokenOperations } from "./tokens.js";

export { AuthError } from "./strategy.js";
export type { AuthConfig, AuthStrategyDefinition, StrategyAnswer } from "./strategy.js";
export type { Identity } from "./identity.js";
export type { TokenOperations, TokenRole } from "./tokens.js";
export { authStrategies };
export { AdminAuthenticationFailedError, resolveAgentRole } from "./hello.js";
export type { SessionRoleResolver } from "./hello.js";

export interface AuthOptions {
  readonly config: AuthConfig;
  readonly dataDirectory: string;
  readonly filesystem: Filesystem;
  readonly secrets: TokenSecrets;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly keySetFetcher: KeySetFetcher;
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
  definitions: readonly AuthStrategyDefinition[],
  options: AuthOptions,
): Auth {
  const store = new TokenStore({
    clock: options.clock,
    filesystem: options.filesystem,
    idGenerator: options.idGenerator,
    path: join(options.dataDirectory, "tokens.json"),
    secrets: options.secrets,
  });
  const adminSecret = new AdminSecretManager({
    filesystem: options.filesystem,
    secrets: options.secrets,
    path: join(options.dataDirectory, "admin.token"),
  });
  const strategies = definitions
    .filter((definition) => definition.enabled(options.config))
    .map((definition) =>
      definition.create({
        config: options.config,
        tokens: store,
        clock: options.clock,
        logger: options.logger,
        keySetFetcher: options.keySetFetcher,
      }),
    );

  return {
    authenticateRequest: async (headers) => {
      let sawCredential = false;
      for (const strategy of strategies) {
        const answer = await strategy.authenticate({ headers });
        if (answer.kind === "identified") return answer.identity;
        if (answer.kind === "rejected") throw new AuthError(401, answer.message, answer.details);
        if (answer.kind === "forbidden") throw new AuthError(403, answer.message);
        sawCredential ||= answer.sawCredential;
      }
      throw new AuthError(401, sawCredential ? "Unknown bearer token" : "Missing bearer token");
    },
    resolveHelloRole: async (hello) => {
      if (hello.credential === undefined) return "agent";
      if ((await store.verify(hello.credential))?.role === "operator") return "admin";
      if (adminSecret.verify(hello.credential)) return "admin";
      throw new AdminAuthenticationFailedError();
    },
    authenticateUplink: async (credential) => {
      if (credential === undefined) return "unauthenticated";
      const record = await store.verify(credential);
      if (record === undefined) return "unauthenticated";
      if (record.role !== "worker") return "forbidden";
      return { outcome: "accept", tokenId: record.id };
    },
    tokens: {
      create: (role, label) => store.create(role, label),
      list: () => store.list(),
      revoke: (id) => store.revoke(id),
    },
    adminSecret: {
      persist: () => adminSecret.persist(),
      remove: () => adminSecret.remove(),
    },
  };
}

export function createAuth(options: AuthOptions): Auth {
  return createAuthFrom(authStrategies, options);
}
