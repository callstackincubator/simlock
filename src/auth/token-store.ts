import {
  inTransaction,
  type Clock,
  type IdGenerator,
  type SqliteDatabase,
  type SqliteSchemaOwner,
  type TokenSecrets,
} from "../ports/index.js";
import type { TokenRecord, TokenRole } from "./tokens.js";

const TOKENS_V1 = `
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('agent', 'operator', 'worker')),
  label TEXT,
  created_at INTEGER NOT NULL
) STRICT;
`;

export const tokensOwner: SqliteSchemaOwner = {
  migrations: [TOKENS_V1],
  name: "tokens",
  version: 1,
};

export interface TokenStoreOptions {
  readonly database: SqliteDatabase;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly secrets: TokenSecrets;
}

export class TokenStore {
  readonly #database: SqliteDatabase;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  readonly #secrets: TokenSecrets;

  constructor(options: TokenStoreOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
    this.#secrets = options.secrets;
  }

  // why: each call is one synchronous transaction, so two at once never see each other half done.
  async create(role: TokenRole, label?: string): Promise<{ record: TokenRecord; secret: string }> {
    const secret = this.#secrets.generateSecret();
    const record: TokenRecord = {
      id: `tok_${this.#idGenerator.generate()}`,
      hash: this.#secrets.hash(secret),
      role,
      ...(label === undefined ? {} : { label }),
      createdAt: this.#clock.now(),
    };
    inTransaction(this.#database, () => {
      this.#database
        .prepare("INSERT INTO tokens (id, hash, role, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(record.id, record.hash, record.role, record.label ?? null, record.createdAt);
    });
    return { record, secret };
  }

  async list(): Promise<TokenRecord[]> {
    return this.#database.prepare("SELECT * FROM tokens ORDER BY rowid").all().map(toRecord);
  }

  async revoke(id: string): Promise<boolean> {
    return inTransaction(
      this.#database,
      () => Number(this.#database.prepare("DELETE FROM tokens WHERE id = ?").run(id).changes) > 0,
    );
  }

  async verify(secret: string): Promise<TokenRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM tokens WHERE hash = ?")
      .get(this.#secrets.hash(secret));
    return row === undefined ? undefined : toRecord(row);
  }
}

function toRecord(row: Record<string, unknown>): TokenRecord {
  return {
    id: row.id as string,
    hash: row.hash as string,
    role: row.role as TokenRole,
    ...(row.label === null ? {} : { label: row.label as string }),
    createdAt: Number(row.created_at),
  };
}
