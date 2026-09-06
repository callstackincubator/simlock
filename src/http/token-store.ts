import { dirname } from "node:path";

import type { Clock, Filesystem, IdGenerator, TokenSecrets } from "../ports/index.js";

/**
 * ADR 0003 §5 (`agent`, `operator`) plus ADR 0005 §8/§25's `worker`: a *join token*, minted on
 * a gateway with `simlock token create --role worker` and presented by a worker when it opens
 * its uplink. It authorizes exactly one thing -- opening an uplink -- and nothing else: the
 * HTTP bearer adapter answers `403` for a `worker` token on any `/v1` route (`auth.ts`), and
 * it resolves to no daemon session role at all. Revoking it closes the uplink, because the
 * gateway re-verifies on every reconnect and the worker is then refused.
 */
export type TokenRole = "agent" | "operator" | "worker";

/** The same three values as a list, for `isTokenRole`'s membership check -- one branch there
 * instead of one per role. Module-private: `TokenRole` is the exported vocabulary. */
const TOKEN_ROLES: readonly TokenRole[] = ["agent", "operator", "worker"];

export interface TokenRecord {
  readonly id: string;
  readonly hash: string;
  readonly role: TokenRole;
  readonly label?: string;
  readonly createdAt: number;
}

export interface TokenIdentity {
  readonly requesterId: string;
  readonly role: TokenRole;
}

export interface TokenStoreOptions {
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly secrets: TokenSecrets;
  readonly path: string;
}

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenStoreError";
  }
}

/**
 * Bearer-token store backed by a JSON file (`tokens.json` under the daemon
 * data directory). Holds only SHA-256 hashes of secrets, never plaintext --
 * `create` is the one call that ever sees a secret, and it hands it back to
 * the caller without persisting it.
 */
export class TokenStore {
  readonly #filesystem: Filesystem;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  readonly #secrets: TokenSecrets;
  readonly #path: string;

  constructor(options: TokenStoreOptions) {
    this.#filesystem = options.filesystem;
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
    this.#secrets = options.secrets;
    this.#path = options.path;
  }

  // fallow-ignore-next-line unused-class-member -- called by `Dispatcher`'s `token.create` handler through `#requireTokens()`'s return value (src/daemon/dispatcher.ts); the audit does not follow a member access on a method's result.
  async create(role: TokenRole, label?: string): Promise<{ record: TokenRecord; secret: string }> {
    const secret = this.#secrets.generateSecret();
    const record: TokenRecord = {
      id: `tok_${this.#idGenerator.generate()}`,
      hash: this.#secrets.hash(secret),
      role,
      ...(label === undefined ? {} : { label }),
      createdAt: this.#clock.now(),
    };

    const records = await this.#readAll();
    records.push(record);
    await this.#writeAll(records);

    return { record, secret };
  }

  async list(): Promise<TokenRecord[]> {
    return this.#readAll();
  }

  // fallow-ignore-next-line unused-class-member -- same as `create` above: reached through `#requireTokens()`'s return value.
  async revoke(id: string): Promise<boolean> {
    const records = await this.#readAll();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return false;

    records.splice(index, 1);
    await this.#writeAll(records);
    return true;
  }

  /**
   * Re-reads tokens.json on every call instead of caching in memory, so a
   * `simlock token create`/`revoke` run from another process takes effect
   * immediately for a long-running process (the daemon) verifying bearer
   * tokens -- there is no in-process invalidation path otherwise.
   */
  async verify(secret: string): Promise<TokenIdentity | undefined> {
    const hash = this.#secrets.hash(secret);
    const record = (await this.#readAll()).find((candidate) => candidate.hash === hash);
    if (record === undefined) return undefined;

    return { requesterId: record.id, role: record.role };
  }

  async #readAll(): Promise<TokenRecord[]> {
    if (!(await this.#filesystem.exists(this.#path))) return [];

    const contents = await this.#filesystem.readFile(this.#path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error: unknown) {
      throw new TokenStoreError(
        `Invalid JSON in token store: ${this.#path} (${errorMessage(error)})`,
      );
    }

    if (!Array.isArray(parsed) || !parsed.every(isTokenRecord)) {
      throw new TokenStoreError(`Invalid token store: ${this.#path}`);
    }

    return parsed;
  }

  async #writeAll(records: readonly TokenRecord[]): Promise<void> {
    await this.#filesystem.mkdirp(dirname(this.#path));
    await this.#filesystem.writeFileAtomic(this.#path, `${JSON.stringify(records, null, 2)}\n`);
  }
}

function isTokenRecord(value: unknown): value is TokenRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.hash === "string" &&
    isTokenRole(record.role) &&
    (record.label === undefined || typeof record.label === "string") &&
    typeof record.createdAt === "number"
  );
}

function isTokenRole(value: unknown): value is TokenRole {
  return typeof value === "string" && (TOKEN_ROLES as readonly string[]).includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
