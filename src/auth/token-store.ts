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

// why: the unique index keeps a worker id pinned to one live token, so a second token cannot take over a paired worker.
const TOKENS_V2 = `
ALTER TABLE tokens ADD COLUMN worker_id TEXT;
CREATE UNIQUE INDEX tokens_worker_id ON tokens (worker_id);
`;

export const tokensOwner: SqliteSchemaOwner = {
  migrations: [TOKENS_V1, TOKENS_V2],
  name: "tokens",
  version: 2,
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

  // why: OR IGNORE leaves the row unpinned when another token holds the id, and the re-read in the same transaction decides, so two first joins at once cannot both win.
  async pinWorker(id: string, workerId: string): Promise<boolean> {
    return inTransaction(this.#database, () => {
      this.#database
        .prepare("UPDATE OR IGNORE tokens SET worker_id = ? WHERE id = ? AND worker_id IS NULL")
        .run(workerId, id);
      const row = this.#database.prepare("SELECT worker_id FROM tokens WHERE id = ?").get(id);
      return row?.worker_id === workerId;
    });
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
    ...(row.worker_id === null ? {} : { workerId: row.worker_id as string }),
  };
}
