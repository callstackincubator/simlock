import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../bus/index.js";
import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";
import type { HistoryProjectionDefinition } from "../index.js";
import { HISTORY_PROJECTIONS } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function openScratch(): Promise<SqliteDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-projection-"));
  directories.push(directory);
  return new NodeSqliteOpener().open(join(directory, "scratch.db"), { readOnly: false });
}

function dumpTables(database: SqliteDatabase): string[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name));
  return tables.flatMap((name) =>
    database
      .prepare(`SELECT * FROM "${name}"`)
      .all()
      .map((row) => `${name} ${JSON.stringify(row)}`)
      .sort(),
  );
}

// why: events that make rows in the registered projection, so a rebuild that does nothing differs from the live rows.
const EVENTS: ReadonlyArray<readonly [EventEnvelope["event"], unknown]> = [
  [
    "lease.requested",
    { requestId: "R1", requestSpec: { platform: "ios" }, requester: "a", waitPolicy: "wait" },
  ],
  [
    "lease.granted",
    {
      deviceId: "d",
      leaseId: "L1",
      platform: "ios",
      requestId: "R1",
      requester: "a",
      source: "warm",
    },
  ],
  ["capacity.changed", { ios: { maxRunning: 4, reserved: 0, running: 1, warm: 0 } }],
  ["device.ready", { bootDuration: 10, deviceId: "d", platform: "ios" }],
  ["lease.released", { deviceId: "d", leaseId: "L1", ownerId: "a", reason: "explicit" }],
  ["daemon.stopping", { reason: "signal" }],
];

function conformance(
  label: string,
  registry: Readonly<Record<string, HistoryProjectionDefinition>>,
) {
  describe.each(Object.entries(registry))(`${label} projection %s`, (_name, definition) => {
    it("its migrations from version 0 reach its version, and the check holds there", async () => {
      const database = await openScratch();
      try {
        for (const migration of definition.migrations) database.exec(migration);

        expect(definition.migrations).toHaveLength(definition.version);
        expect(definition.check(database)).toBe(true);
      } finally {
        database.close();
      }
    });

    it("a rebuild over the events apply saw gives the same rows", async () => {
      const database = await openScratch();
      try {
        for (const migration of definition.migrations) database.exec(migration);
        const projector = definition.create(database, {
          fleet: false,
          metricsRetentionMs: 90 * 24 * 3_600_000,
        });
        const envelopes = EVENTS.map(
          ([event, payload], index): EventEnvelope =>
            ({
              event,
              id: `evt_${index}`,
              module: "daemon",
              payload,
              seq: index,
              timestamp: 1_000 + 20_000 * index,
            }) as never,
        );
        for (const envelope of envelopes) projector.apply(envelope);
        const live = dumpTables(database);
        expect(live.length).toBeGreaterThan(0);

        projector.rebuild(1_000);
        for (const envelope of envelopes) projector.apply(envelope);

        expect(dumpTables(database)).toEqual(live);
      } finally {
        database.close();
      }
    });

    it("a rebuild over events that cross a crash gives the rows the runs wrote live", async () => {
      const database = await openScratch();
      try {
        for (const migration of definition.migrations) database.exec(migration);
        const options = { fleet: false, metricsRetentionMs: 90 * 24 * 3_600_000 };
        const at = (minutes: number): number => 60_000 * 1_000 + minutes * 60_000;
        const envelope = (
          index: number,
          seq: number,
          minutes: number,
          event: EventEnvelope["event"],
          payload: unknown,
        ): EventEnvelope =>
          ({
            event,
            id: `evt_${index}`,
            module: "daemon",
            payload,
            seq,
            timestamp: at(minutes),
          }) as never;
        const capacity = { ios: { maxRunning: 4, reserved: 0, running: 1, warm: 0 } };
        const crashed = [envelope(0, 1, 0, "capacity.changed", capacity)];
        const next = [
          envelope(1, 1, 10, "capacity.changed", capacity),
          envelope(2, 2, 10, "daemon.started", { configSnapshot: {}, version: "1" }),
          envelope(3, 3, 12, "daemon.stopping", { reason: "signal" }),
        ];
        for (const event of crashed) definition.create(database, options).apply(event);
        const second = definition.create(database, options);
        for (const event of next) second.apply(event);
        const live = dumpTables(database);
        expect(live.length).toBeGreaterThan(0);

        second.rebuild(at(0));
        for (const event of [...crashed, ...next]) second.apply(event);

        expect(dumpTables(database)).toEqual(live);
      } finally {
        database.close();
      }
    });
  });
}

describe("the history projection conformance suite", () => {
  conformance("registered", HISTORY_PROJECTIONS);
  conformance("test", {
    counter: {
      check: () => true,
      create: (database) => {
        database.exec("CREATE TABLE IF NOT EXISTS counted (id TEXT PRIMARY KEY)");
        const insert = database.prepare("INSERT INTO counted (id) VALUES (?)");
        return {
          apply: (envelope) => void insert.run(envelope.id),
          prune: () => undefined,
          rebuild: () => database.exec("DELETE FROM counted"),
        };
      },
      migrations: [],
      name: "counter",
      version: 0,
    },
  });
});
