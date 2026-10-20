import { describe, expect, it, vi } from "vitest";

import { FakeClock } from "../ports/index.js";
import type { SqliteDatabase } from "../ports/index.js";
import type { TokenSecrets } from "../ports/token-secrets.js";
import { openMemoryStateDatabase } from "./testing.js";
import { TokenStore, tokensOwner } from "./token-store.js";

class FakeTokenSecrets implements TokenSecrets {
  #nextSecret = 0;

  generateSecret(): string {
    this.#nextSecret += 1;
    return `slk_fake-secret-${this.#nextSecret}`;
  }

  hash(secret: string): string {
    return `hash-of-${[...secret].reverse().join("")}`;
  }
}

async function tokenStore(
  overrides: {
    database?: SqliteDatabase;
    clock?: FakeClock;
    secrets?: TokenSecrets;
    ids?: readonly string[];
  } = {},
): Promise<{ store: TokenStore; database: SqliteDatabase }> {
  const database = overrides.database ?? (await openMemoryStateDatabase([tokensOwner])).database;
  const ids = [...(overrides.ids ?? ["id-1", "id-2", "id-3"])];
  return {
    database,
    store: new TokenStore({
      clock: overrides.clock ?? new FakeClock(1_000),
      database,
      idGenerator: { generate: () => ids.shift() ?? "id-overflow" },
      secrets: overrides.secrets ?? new FakeTokenSecrets(),
    }),
  };
}

function storedRows(database: SqliteDatabase): Record<string, unknown>[] {
  return database.prepare("SELECT * FROM tokens ORDER BY rowid").all();
}

describe("TokenStore", () => {
  it("creates a token, returning the secret once and persisting only its hash", async () => {
    const { store, database } = await tokenStore();

    const { record, secret } = await store.create("agent", "ci-runner");

    expect(secret).toBe("slk_fake-secret-1");
    expect(record).toEqual({
      id: "tok_id-1",
      hash: "hash-of-1-terces-ekaf_kls",
      role: "agent",
      label: "ci-runner",
      createdAt: 1_000,
    });

    const rows = storedRows(database);
    expect(rows).toEqual([
      {
        id: record.id,
        hash: record.hash,
        role: "agent",
        label: "ci-runner",
        created_at: 1_000,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("fake-secret");
  });

  it("creates a token without a label when none is given", async () => {
    const { store } = await tokenStore();

    const { record } = await store.create("operator");

    expect(record.label).toBeUndefined();
    expect("label" in record).toBe(false);
    const [listed] = await store.list();
    expect(listed).toEqual(record);
    expect("label" in (listed ?? {})).toBe(false);
  });

  it("refuses a role outside the token roles at insert", async () => {
    const { database } = await tokenStore();

    expect(() =>
      database
        .prepare("INSERT INTO tokens (id, hash, role, label, created_at) VALUES (?, ?, ?, NULL, 0)")
        .run("tok_bad", "hash", "admin"),
    ).toThrow(/CHECK/);
  });

  it("lists previously created tokens in creation order", async () => {
    const { store } = await tokenStore({ ids: ["c", "b", "a"] });
    await store.create("agent", "one");
    await store.create("operator", "two");
    await store.create("worker", "three");

    const records = await store.list();

    expect(records.map((record) => record.label)).toEqual(["one", "two", "three"]);
  });

  it("persists and verifies both tokens created concurrently", async () => {
    const { store, database } = await tokenStore();

    const created = await Promise.all([
      store.create("agent", "one"),
      store.create("operator", "two"),
    ]);

    expect(storedRows(database).map((row) => row.id)).toEqual(
      expect.arrayContaining(created.map(({ record }) => record.id)),
    );
    expect(storedRows(database)).toHaveLength(2);
    await expect(Promise.all(created.map(({ secret }) => store.verify(secret)))).resolves.toEqual(
      created.map(({ record }) => record),
    );
  });

  it.each(["create-first", "revoke-first"])(
    "preserves a concurrent create and revoke (%s)",
    async (order) => {
      const { store, database } = await tokenStore();
      const existing = await store.create("agent", "old");
      const create = () => store.create("operator", "new");
      const revoke = () => store.revoke(existing.record.id);

      const [created, revoked] = await (order === "create-first"
        ? Promise.all([create(), revoke()])
        : Promise.all([revoke(), create()]).then(([removed, added]) => [added, removed] as const));

      expect(revoked).toBe(true);
      expect(storedRows(database).map((row) => row.id)).toEqual([created.record.id]);
      await expect(store.verify(existing.secret)).resolves.toBeUndefined();
      await expect(store.verify(created.secret)).resolves.toEqual(created.record);
    },
  );

  it("keeps both concurrent revocations effective", async () => {
    const { store, database } = await tokenStore();
    const first = await store.create("agent");
    const second = await store.create("operator");

    await expect(
      Promise.all([store.revoke(first.record.id), store.revoke(second.record.id)]),
    ).resolves.toEqual([true, true]);

    expect(storedRows(database)).toEqual([]);
    await expect(store.verify(first.secret)).resolves.toBeUndefined();
    await expect(store.verify(second.secret)).resolves.toBeUndefined();
  });

  it.each(["create", "revoke"])(
    "rejects a failed %s write and lets a queued mutation persist",
    async (operation) => {
      const { store, database } = await tokenStore();
      const existing = await store.create("agent");
      const failure = new Error("token write failed");
      vi.spyOn(database, "prepare").mockImplementationOnce(() => {
        throw failure;
      });

      const failed =
        operation === "create" ? store.create("worker") : store.revoke(existing.record.id);
      const next = store.create("operator");

      await expect(failed).rejects.toBe(failure);
      await expect(next).resolves.toMatchObject({ record: { role: "operator" } });
      const created = await next;
      expect(storedRows(database).map((row) => row.id)).toEqual([
        existing.record.id,
        created.record.id,
      ]);
      await expect(store.verify(created.secret)).resolves.toEqual(created.record);
    },
  );

  it("verifies a token by hashing the presented secret against stored hashes", async () => {
    const { store } = await tokenStore();
    const { record, secret } = await store.create("operator", "root");

    await expect(store.verify(secret)).resolves.toEqual(record);
    await expect(store.verify("slk_not-a-real-secret")).resolves.toBeUndefined();
  });

  it("verifies on every call against the table, seeing tokens created by another store instance", async () => {
    const { database } = await tokenStore();
    const secrets = new FakeTokenSecrets();
    const writer = (await tokenStore({ database, secrets, ids: ["writer-id"] })).store;
    const reader = (await tokenStore({ database, secrets, ids: ["unused"] })).store;

    await expect(reader.verify("slk_fake-secret-1")).resolves.toBeUndefined();
    const { secret } = await writer.create("agent");

    await expect(reader.verify(secret)).resolves.toMatchObject({
      id: "tok_writer-id",
      role: "agent",
    });
  });

  it("revokes an existing token and reports success", async () => {
    const { store } = await tokenStore();
    const { record } = await store.create("agent");

    await expect(store.revoke(record.id)).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("returns false revoking an unknown token id", async () => {
    const { store } = await tokenStore();

    await expect(store.revoke("tok_does-not-exist")).resolves.toBe(false);
  });

  it("verifies and revokes nothing on an empty table", async () => {
    const { store } = await tokenStore();

    await expect(store.verify("slk_anything")).resolves.toBeUndefined();
    await expect(store.revoke("tok_anything")).resolves.toBe(false);
  });
});
