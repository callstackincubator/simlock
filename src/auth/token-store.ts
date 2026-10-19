import { dirname } from "node:path";

import type { Clock, Filesystem, IdGenerator, TokenSecrets } from "../ports/index.js";
import type { TokenRecord, TokenRole } from "./tokens.js";

const TOKEN_ROLES: readonly TokenRole[] = ["agent", "operator", "worker"];

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

export class TokenStore {
  readonly #filesystem: Filesystem;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  readonly #secrets: TokenSecrets;
  readonly #path: string;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: TokenStoreOptions) {
    this.#filesystem = options.filesystem;
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
    this.#secrets = options.secrets;
    this.#path = options.path;
  }

  async create(role: TokenRole, label?: string): Promise<{ record: TokenRecord; secret: string }> {
    return this.#mutate(async () => {
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
    });
  }

  async list(): Promise<TokenRecord[]> {
    return this.#readAll();
  }

  async revoke(id: string): Promise<boolean> {
    return this.#mutate(async () => {
      const records = await this.#readAll();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return false;

      records.splice(index, 1);
      await this.#writeAll(records);
      return true;
    });
  }

  // why: re-reading on every call is what lets a `token create`/`revoke` from another process take effect in the long-running daemon, which has no invalidation path.
  async verify(secret: string): Promise<TokenRecord | undefined> {
    const hash = this.#secrets.hash(secret);
    return (await this.#readAll()).find((candidate) => candidate.hash === hash);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation);
    this.#mutation = result.then(
      () => {},
      () => {},
    );
    return result;
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
    await this.#filesystem.writeFileAtomic(this.#path, `${JSON.stringify(records, null, 2)}\n`, {
      mode: 0o600,
    });
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
