import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baselinesOwner, NoDriverError } from "../core/index.js";
import type { TestEngine } from "../leasing/testing.js";
import { NodeFilesystem, NodeSqliteOpener, NoopLogger } from "../ports/index.js";
import { openStateDatabase } from "../state/index.js";
import { backendOwnershipWorld as world } from "./test-backend-ownership.js";

async function save(engine: TestEngine, name: string) {
  const grant = await engine.request(
    {
      platform: "ios",
      model: "iPhone 16",
      osVersion: "26.5",
    },
    { ownerId: "agent", requesterId: name },
  );
  const baseline = await engine.core.baselines.save({
    leaseId: grant.lease.id,
    name,
    requesterId: "operator",
  });
  await engine.settle();
  return baseline;
}

describe("backend-owned baseline sources", () => {
  it("migrates a real version 1 baseline database to local ownership while preserving its source and saved metadata", async () => {
    const temporaryRoot = tmpdir();
    const template = join(temporaryRoot, "simlock-baseline-backend-");
    const directory = await mkdtemp(template);
    try {
      const filesystem = new NodeFilesystem();
      const logger = new NoopLogger();
      const sqlite = new NodeSqliteOpener();
      const open = (owner: typeof baselinesOwner) =>
        openStateDatabase({
          dataDirectory: directory,
          filesystem,
          logger,
          sqlite,
          oldFiles: [],
          owners: [owner],
          upgradeStep: "remove it.",
        });
      const legacyOwner = {
        ...baselinesOwner,
        version: 1,
        migrations: baselinesOwner.migrations.slice(0, 1),
      };
      const legacy = await open(legacyOwner);
      const insert = legacy.database.prepare(
        "INSERT INTO baselines (name, version, platform, model, os_version, mode, image_tag, note, saved_at, source_id, stale_reason) VALUES ('login', 3, 'ios', 'iPhone 16', '26.5', 'full', NULL, 'saved login', '2026-11-10T12:00:00.000Z', 'opaque-existing-source', NULL)",
      );
      insert.run();
      legacy.close();

      const migrated = await open(baselinesOwner);
      try {
        const statement = migrated.database.prepare("SELECT * FROM baselines");
        const rows = statement.all();
        expect(rows).toEqual([
          {
            backend: "local",
            name: "login",
            version: 3,
            platform: "ios",
            model: "iPhone 16",
            os_version: "26.5",
            mode: "full",
            image_tag: null,
            note: "saved login",
            saved_at: "2026-11-10T12:00:00.000Z",
            source_id: "opaque-existing-source",
            stale_reason: null,
          },
        ]);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps listings, stale checks and source names separate when two backends use the same source id", async () => {
    const context = await world();
    try {
      const local = await context.select("local");
      await save(local.engine, "local-login");
      const remote = await context.select("remote");
      await save(remote.engine, "remote-login");
      const localSources = await local.driver.listSources();
      const remoteSources = await remote.driver.listSources();
      expect(localSources[0]?.id).toBe(remoteSources[0]?.id);
      const remoteSource = remoteSources[0];
      if (remoteSource === undefined) throw new Error("Expected saved remote source");
      remote.driver.setSources([
        { ...remoteSource, sizeBytes: 99, staleReason: "remote runtime missing" },
      ]);

      const listed = await remote.engine.core.baselines.list();

      expect(listed).toMatchObject([
        {
          name: "local-login",
          staleReason: "the ios:local backend is not available on this worker",
        },
        { name: "remote-login", sizeBytes: 99, staleReason: "remote runtime missing" },
      ]);
      expect(listed[0]?.sizeBytes).toBeUndefined();
      const localQuery = context.state.database.prepare(
        "SELECT backend, stale_reason FROM baselines WHERE name = ?",
      );
      const localRow = localQuery.get("local-login");
      expect(localRow).toEqual({ backend: "local", stale_reason: null });
      const named = remote.engine.core.baselines.nameSources(remoteSources, {
        platform: "ios",
        backend: "remote",
      });
      expect(named[0]?.baselineName).toBe("remote-login");

      const restored = await context.select("local");
      const current = restored.engine.core.baselines.current("local-login");
      expect(current?.backend).toBe("local");
      expect(current?.staleReason).toBeUndefined();
    } finally {
      context.close();
    }
  });

  it("refuses foreign removal and replacement before ending a lease, and nuke preserves the foreign source and row", async () => {
    const context = await world();
    try {
      const local = await context.select("local");
      await save(local.engine, "local-login");
      const remote = await context.select("remote");
      await save(remote.engine, "remote-login");
      const grant = await remote.engine.request(
        {
          platform: "ios",
          model: "iPhone 16",
          osVersion: "26.5",
        },
        { ownerId: "agent", requesterId: "replacement" },
      );
      const before = remote.driver.calls.length;

      const removing = remote.engine.core.baselines.remove({
        name: "local-login",
        requesterId: "operator",
      });
      await expect(removing).rejects.toBeInstanceOf(NoDriverError);
      const replacing = remote.engine.core.baselines.save({
        leaseId: grant.lease.id,
        name: "local-login",
        requesterId: "operator",
      });
      await expect(replacing).rejects.toBeInstanceOf(NoDriverError);

      const lease = remote.registry.snapshot.leases.find(
        (current) => current.id === grant.lease.id,
      );
      expect(lease).toEqual(grant.lease);
      expect(remote.driver.calls.length).toBe(before);
      await remote.engine.release(grant.lease.id, "explicit");
      await remote.engine.settle();
      const result = await remote.engine.nuke(true);
      expect(result.removedBaselines).toEqual(["remote-login"]);
      const remainingQuery = context.state.database.prepare("SELECT name, backend FROM baselines");
      const remaining = remainingQuery.all();
      expect(remaining).toEqual([{ name: "local-login", backend: "local" }]);
      const remoteSources = await remote.driver.listSources();
      const localSources = await local.driver.listSources();
      expect(remoteSources).toEqual([]);
      expect(localSources).toHaveLength(1);

      const restored = await context.select("local");
      const removed = await restored.engine.core.baselines.remove({
        name: "local-login",
        requesterId: "operator",
      });
      expect(removed.versions).toEqual([1]);
    } finally {
      context.close();
    }
  });

  it("keeps a replaced version's source and row while that version's backend is unavailable", async () => {
    const context = await world();
    try {
      const local = await context.select("local");
      await save(local.engine, "history");
      await local.engine.core.baselines.dropReplaced();
      const sources = await local.driver.listSources();
      const first = sources[0];
      if (first === undefined) throw new Error("Expected the first saved source");
      local.driver.setSources([first, { ...first, id: "history-second" }]);
      const insert = context.state.database.prepare(
        "INSERT INTO baselines (name, version, platform, backend, model, os_version, mode, image_tag, note, saved_at, source_id) SELECT name, 2, platform, backend, model, os_version, mode, image_tag, note, saved_at, 'history-second' FROM baselines WHERE name = 'history' AND version = 1",
      );
      insert.run();
      const remote = await context.select("remote");
      await save(remote.engine, "remote-login");
      const before = remote.driver.calls.length;

      await remote.engine.core.baselines.dropReplaced();

      expect(remote.driver.calls.length).toBe(before);
      const statement = context.state.database.prepare(
        "SELECT version, backend FROM baselines WHERE name = ? ORDER BY version",
      );
      const versions = statement.all("history");
      expect(versions).toEqual([
        { version: 1, backend: "local" },
        { version: 2, backend: "local" },
      ]);
      const remoteSources = await remote.driver.listSources();
      const localSources = await local.driver.listSources();
      expect(remoteSources).toHaveLength(1);
      expect(localSources).toHaveLength(2);
    } finally {
      context.close();
    }
  });
});
