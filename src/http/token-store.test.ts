import { describe, expect, it, vi } from "vitest";

import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import type { TokenSecrets } from "../ports/token-secrets.js";
import { TokenStore, TokenStoreError } from "./token-store.js";

const tokensPath = "/home/agent/.simlock/tokens.json";

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

function tokenStore(
  overrides: {
    filesystem?: MemoryFilesystem;
    clock?: FakeClock;
    secrets?: TokenSecrets;
    ids?: readonly string[];
  } = {},
): { store: TokenStore; filesystem: MemoryFilesystem } {
  const filesystem = overrides.filesystem ?? new MemoryFilesystem();
  const ids = [...(overrides.ids ?? ["id-1", "id-2", "id-3"])];
  return {
    filesystem,
    store: new TokenStore({
      clock: overrides.clock ?? new FakeClock(1_000),
      filesystem,
      idGenerator: { generate: () => ids.shift() ?? "id-overflow" },
      path: tokensPath,
      secrets: overrides.secrets ?? new FakeTokenSecrets(),
    }),
  };
}

describe("TokenStore", () => {
  it("lists no tokens when the file does not exist", async () => {
    const { store } = tokenStore();

    await expect(store.list()).resolves.toEqual([]);
  });

  it("creates a token, returning the secret once and persisting only its hash", async () => {
    const { store, filesystem } = tokenStore();

    const { record, secret } = await store.create("agent", "ci-runner");

    expect(secret).toBe("slk_fake-secret-1");
    expect(record).toEqual({
      id: "tok_id-1",
      hash: "hash-of-1-terces-ekaf_kls",
      role: "agent",
      label: "ci-runner",
      createdAt: 1_000,
    });

    const persisted = JSON.parse(await filesystem.readFile(tokensPath)) as unknown[];
    expect(persisted).toEqual([record]);
    expect(JSON.stringify(persisted)).not.toContain("fake-secret");
  });

  it("creates a token without a label when none is given", async () => {
    const { store } = tokenStore();

    const { record } = await store.create("operator");

    expect(record.label).toBeUndefined();
    expect("label" in record).toBe(false);
  });

  it("lists previously created tokens", async () => {
    const { store } = tokenStore();
    await store.create("agent", "one");
    await store.create("operator", "two");

    const records = await store.list();

    expect(records.map((record) => record.label)).toEqual(["one", "two"]);
  });

  it("persists and verifies both tokens created concurrently", async () => {
    const { store, filesystem } = tokenStore();

    const created = await Promise.all([
      store.create("agent", "one"),
      store.create("operator", "two"),
    ]);

    const persisted = JSON.parse(await filesystem.readFile(tokensPath)) as unknown[];
    expect(persisted).toHaveLength(2);
    expect(persisted).toEqual(expect.arrayContaining(created.map(({ record }) => record)));
    await expect(Promise.all(created.map(({ secret }) => store.verify(secret)))).resolves.toEqual(
      created.map(({ record }) => ({ requesterId: record.id, role: record.role })),
    );
  });

  it.each(["create-first", "revoke-first"])(
    "preserves a concurrent create and revoke (%s)",
    async (order) => {
      const { store, filesystem } = tokenStore();
      const existing = await store.create("agent", "old");
      const create = () => store.create("operator", "new");
      const revoke = () => store.revoke(existing.record.id);

      const [created, revoked] = await (order === "create-first"
        ? Promise.all([create(), revoke()])
        : Promise.all([revoke(), create()]).then(([removed, added]) => [added, removed] as const));

      expect(revoked).toBe(true);
      expect(JSON.parse(await filesystem.readFile(tokensPath))).toEqual([created.record]);
      await expect(store.verify(existing.secret)).resolves.toBeUndefined();
      await expect(store.verify(created.secret)).resolves.toEqual({
        requesterId: created.record.id,
        role: "operator",
      });
    },
  );

  it("keeps both concurrent revocations effective", async () => {
    const { store, filesystem } = tokenStore();
    const first = await store.create("agent");
    const second = await store.create("operator");

    await expect(
      Promise.all([store.revoke(first.record.id), store.revoke(second.record.id)]),
    ).resolves.toEqual([true, true]);

    expect(JSON.parse(await filesystem.readFile(tokensPath))).toEqual([]);
    await expect(store.verify(first.secret)).resolves.toBeUndefined();
    await expect(store.verify(second.secret)).resolves.toBeUndefined();
  });

  it.each(["create", "revoke"])(
    "rejects a failed %s write and lets a queued mutation persist",
    async (operation) => {
      const { store, filesystem } = tokenStore();
      const existing = await store.create("agent");
      const failure = new Error("token write failed");
      vi.spyOn(filesystem, "writeFileAtomic").mockRejectedValueOnce(failure);

      const failed =
        operation === "create" ? store.create("worker") : store.revoke(existing.record.id);
      const next = store.create("operator");

      await expect(failed).rejects.toBe(failure);
      await expect(next).resolves.toMatchObject({ record: { role: "operator" } });
      const created = await next;
      expect(JSON.parse(await filesystem.readFile(tokensPath))).toEqual([
        existing.record,
        created.record,
      ]);
      await expect(store.verify(created.secret)).resolves.toEqual({
        requesterId: created.record.id,
        role: "operator",
      });
    },
  );

  it("verifies a token by hashing the presented secret against stored hashes", async () => {
    const { store } = tokenStore();
    const { record, secret } = await store.create("operator", "root");

    await expect(store.verify(secret)).resolves.toEqual({
      requesterId: record.id,
      role: "operator",
    });
    await expect(store.verify("slk_not-a-real-secret")).resolves.toBeUndefined();
  });

  it("re-reads the file on every verify, seeing tokens created by another store instance", async () => {
    const filesystem = new MemoryFilesystem();
    const secrets = new FakeTokenSecrets();
    const writer = tokenStore({ filesystem, secrets, ids: ["writer-id"] }).store;
    const reader = tokenStore({ filesystem, secrets, ids: ["unused"] }).store;

    await expect(reader.verify("slk_fake-secret-1")).resolves.toBeUndefined();
    const { secret } = await writer.create("agent");

    await expect(reader.verify(secret)).resolves.toEqual({
      requesterId: "tok_writer-id",
      role: "agent",
    });
  });

  it("revokes an existing token and reports success", async () => {
    const { store } = tokenStore();
    const { record } = await store.create("agent");

    await expect(store.revoke(record.id)).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("returns false revoking an unknown token id", async () => {
    const { store } = tokenStore();

    await expect(store.revoke("tok_does-not-exist")).resolves.toBe(false);
  });

  it("tolerates a missing tokens file as an empty store", async () => {
    const { store } = tokenStore();

    await expect(store.verify("slk_anything")).resolves.toBeUndefined();
    await expect(store.revoke("tok_anything")).resolves.toBe(false);
  });

  it("fails loudly instead of silently resetting on corrupt JSON", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(tokensPath, "{ not valid json");
    const { store } = tokenStore({ filesystem });

    await expect(store.list()).rejects.toThrow(TokenStoreError);
    await expect(filesystem.readFile(tokensPath)).resolves.toBe("{ not valid json");
  });

  it("fails loudly when the file holds valid JSON that is not a token array", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(tokensPath, JSON.stringify({ not: "an array" }));
    const { store } = tokenStore({ filesystem });

    await expect(store.list()).rejects.toThrow(TokenStoreError);
  });
});
