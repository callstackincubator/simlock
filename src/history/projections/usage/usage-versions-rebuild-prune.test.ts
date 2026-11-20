import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteOpener } from "../../../ports/index.js";
import { type HistoryProjectionDefinition } from "../../index.js";
import {
  MIN,
  HOUR,
  DAY,
  T0,
  directories,
  type Rig,
  rig,
  count,
  execOn,
  rowsOf,
  factsOf,
  buckets,
  row,
  requested,
  granted,
  capacity,
} from "./test-usage.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("usage projection: versions", () => {
  const versioned = (
    version: number,
    migrations: readonly string[],
  ): HistoryProjectionDefinition => ({
    check: () => true,
    create: (database) => ({
      apply: (envelope) => {
        if (version === 1) {
          database.prepare("INSERT INTO kept (id) VALUES (?)").run(envelope.id);
        }
      },
      prune: () => undefined,
      rebuild: () => undefined,
    }),
    migrations,
    name: "kept",
    version,
  });
  const CREATE = "CREATE TABLE kept (id TEXT)";
  const ADD = "ALTER TABLE kept ADD COLUMN extra INTEGER DEFAULT 7";

  it("a stored version below the code's is migrated and keeps its rows", async () => {
    const first = await rig({ projections: [versioned(1, [CREATE])] });
    first.emit("daemon.stopping", { reason: "a" });
    await first.history.stop();

    const second = await rig({
      directory: first.directory,
      projections: [versioned(2, [CREATE, ADD])],
    });
    const database = await new NodeSqliteOpener().open(second.path, { readOnly: true });
    try {
      const kept = database.prepare("SELECT id, extra FROM kept").all();
      expect(kept).toHaveLength(1);
      expect(kept[0]?.extra).toBe(7);
    } finally {
      database.close();
    }
    await second.history.stop();
  });

  it("a migration that throws, or a stored version above the code's, makes start() reject naming the projection and versions, with every row kept", async () => {
    const first = await rig({ projections: [versioned(1, [CREATE])] });
    first.emit("daemon.stopping", { reason: "a" });
    await first.history.stop();

    const broken = await rig({
      directory: first.directory,
      projections: [versioned(2, [CREATE, "ALTER TABLE missing ADD COLUMN x INTEGER"])],
      start: false,
    });
    await expect(broken.history.start()).rejects.toThrow(/kept.*1.*2/s);
    await broken.history.stop();
    const accepted = await rig({
      directory: first.directory,
      projections: [versioned(3, [CREATE, ADD, ADD.replace("extra", "more")])],
    });
    accepted.emit("daemon.stopping", { reason: "b" });
    await accepted.history.stop();

    const newer = await rig({
      directory: first.directory,
      projections: [versioned(2, [CREATE, ADD])],
      start: false,
    });
    await expect(newer.history.start()).rejects.toThrow(/kept.*3.*2/s);
    await newer.history.stop();

    expect(await count(first, "SELECT count(*) AS n FROM kept")).toBe(1);
  });
});

describe("usage projection: rebuild", () => {
  async function seed(r: Rig, requests: number): Promise<void> {
    for (let index = 0; index < requests; index += 1) {
      r.at(T0 + index);
      r.emit("lease.requested", requested(`R${index}`));
      if (index % 7 === 0) r.emit("lease.granted", granted(`L${index}`, `R${index}`));
    }
    r.emit("device.ready", { bootDuration: 10, deviceId: "d", platform: "ios" });
    r.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
  }
  const breakMinuteTable = (path: string) =>
    execOn(path, "ALTER TABLE minute_rows DROP COLUMN knownMs");

  it("a failed check rebuilds in batches with other work running between them: rows older than the oldest event are kept, the rest equal the live rows, an event emitted mid-rebuild is projected once, and status() gives rebuiltAt after; a start with nothing to fix gives neither field", async () => {
    const first = await rig({ eventRetention: DAY });
    first.at(T0 - 2 * DAY);
    first.emit("lease.requested", requested("OLD"));
    first.at(T0);
    await seed(first, 2_100);
    const live = {
      facts: await factsOf(first),
      minutes: await buckets(first, { from: T0, platform: "ios", to: T0 + 5 * MIN }),
      requests: (await rowsOf(first)).filter((candidate) => candidate.requestId !== "OLD"),
    };
    await first.history.stop();
    await breakMinuteTable(first.path);

    const second = await rig({
      at: T0 + MIN,
      directory: first.directory,
      eventRetention: DAY,
      start: false,
    });
    let between = 0;
    const ticker = setInterval(() => undefined, 1);
    const tick = (): void => {
      const status = second.history.status();
      if (status.opened && status.rebuiltAt === undefined) {
        between += 1;
        if (between === 1) second.emit("lease.requested", requested("MID"));
      }
      if (status.rebuiltAt === undefined) setImmediate(tick);
    };
    setImmediate(tick);
    await second.history.start();
    clearInterval(ticker);

    const requests = await rowsOf(second);
    expect(second.history.status().rebuiltAt).toBe(T0 + MIN);
    expect(between).toBeGreaterThanOrEqual(2);
    expect(requests.filter((candidate) => candidate.requestId === "MID")).toHaveLength(1);
    expect(requests.filter((candidate) => candidate.requestId === "OLD")).toHaveLength(1);
    expect(requests.filter((candidate) => !["MID", "OLD"].includes(candidate.requestId))).toEqual(
      live.requests,
    );
    expect(await factsOf(second)).toEqual(live.facts);
    const withMid = live.minutes.map((bucket) =>
      bucket.start < T0 + MIN
        ? bucket
        : {
            // why: the first run was never stopped, so the second run (MID is its first event) carries none of its other levels over the downtime.
            knownMs: bucket.knownMs,
            start: bucket.start,
            waiting: {
              integral: (bucket.waiting?.integral ?? 0) + MIN,
              peak: (bucket.waiting?.peak ?? 0) + 1,
            },
          },
    );
    expect(await buckets(second, { from: T0, platform: "ios", to: T0 + 5 * MIN })).toEqual(withMid);
    await second.history.stop();

    const third = await rig({ at: T0 + 2 * MIN, directory: first.directory, eventRetention: DAY });
    expect(third.history.status()).not.toHaveProperty("rebuiltAt");
    expect(third.history.status()).not.toHaveProperty("rebuildFailed");
    await third.history.stop();
  });

  it("a stop mid-rebuild leaves the mark and the next start rebuilds", async () => {
    const first = await rig();
    await seed(first, 2_100);
    const live = await rowsOf(first);
    await first.history.stop();
    await breakMinuteTable(first.path);

    const second = await rig({ at: T0 + MIN, directory: first.directory, start: false });
    const starting = second.history.start();
    const stopping = new Promise<void>((resolve) => {
      const wait = (): void => {
        const status = second.history.status();
        if (status.opened && status.rebuiltAt === undefined)
          void second.history.stop().then(resolve);
        else setImmediate(wait);
      };
      setImmediate(wait);
    });
    await Promise.all([starting, stopping]);

    const third = await rig({ at: T0 + 2 * MIN, directory: first.directory });
    expect(third.history.status().rebuiltAt).toBe(T0 + 2 * MIN);
    expect(await rowsOf(third)).toEqual(live);
    await third.history.stop();
  });

  it("a rebuild that throws leaves no rows for the events' window, rebuildFailed true, writing true, no rebuiltAt, one error, and later events are still written", async () => {
    const first = await rig();
    await seed(first, 2_100);
    await first.history.stop();
    await breakMinuteTable(first.path);
    await execOn(
      first.path,
      "CREATE TRIGGER refuse BEFORE INSERT ON request_rows WHEN NEW.requestId = 'R1500' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );

    const second = await rig({ at: T0 + MIN, directory: first.directory });
    second.emit("lease.requested", requested("LATER"));
    const status = second.history.status();
    const stored = await second.history.replay({ sinceTs: 0 });

    expect(status).toMatchObject({ rebuildFailed: true, writing: true });
    expect(status).not.toHaveProperty("rebuiltAt");
    expect(second.logs.records.filter((record) => record.level === "error")).toHaveLength(1);
    expect(await rowsOf(second)).toEqual([]);
    expect(
      stored.some(
        (envelope) =>
          envelope.payload && (envelope.payload as { requestId?: string }).requestId === "LATER",
      ),
    ).toBe(true);
    await second.history.stop();
  });
});

describe("usage projection: prune", () => {
  it("prune deletes request, minute, device fact and held lease rows older than metrics.retention and keeps one at the cutoff, at start and one hour later", async () => {
    const retention = 10 * DAY;
    const cutoff = T0;
    const first = await rig({
      at: cutoff - 5 * MIN,
      eventRetention: DAY,
      fleet: true,
      metricsRetention: retention,
    });
    const mark = (at: number, name: string): void => {
      first.at(at);
      first.emit("lease.requested", requested(`R-${name}`));
      first.emit("device.ready", { bootDuration: 5, deviceId: `d-${name}`, platform: "ios" });
      first.relay("w1", "lease.granted", granted(`L-${name}`, `X-${name}`));
      first.emit("daemon.stopping", { reason: name });
      first.emit("capacity.changed", capacity({ ios: [1, 0, 4] }));
    };
    mark(cutoff - 1_000, "old");
    mark(cutoff, "edge");
    mark(cutoff + HOUR, "new");
    await first.history.stop();

    const second = await rig({
      at: cutoff + retention,
      directory: first.directory,
      eventRetention: DAY,
      fleet: true,
      metricsRetention: retention,
    });
    const heldSource = async (name: string, workerLeaseId: string) => {
      second.emit("lease.requested", requested(`Q-${name}`));
      second.emit("request.granted", {
        leaseId: `G-${name}`,
        requestId: `Q-${name}`,
        worker: "w1",
        workerLeaseId,
      });
      return row(await rowsOf(second), `Q-${name}`).source;
    };
    const minutesOf = async () =>
      (
        await buckets(second, {
          from: cutoff - 2 * MIN,
          platform: "ios",
          to: cutoff + HOUR + MIN,
          workerId: "*",
        })
      ).map((bucket) => bucket.start);
    const afterStart = {
      facts: (await factsOf(second)).map((fact) => fact.deviceId),
      minutes: await minutesOf(),
      requests: (await rowsOf(second)).map((candidate) => candidate.requestId),
    };
    const startSources = [
      await heldSource("start-old", "L-old"),
      await heldSource("start-edge", "L-edge"),
      await heldSource("start-new", "L-new"),
    ];
    second.clock.advance(HOUR);
    const afterHour = {
      facts: (await factsOf(second)).map((fact) => fact.deviceId),
      minutes: await minutesOf(),
      requests: (await rowsOf(second))
        .map((candidate) => candidate.requestId)
        .filter((requestId) => requestId.startsWith("R-")),
    };
    const hourSources = [
      await heldSource("hour-edge", "L-edge"),
      await heldSource("hour-new", "L-new"),
    ];

    expect(afterStart.requests).toEqual(["R-edge", "R-new"]);
    expect(afterStart.facts).toEqual(["d-edge", "d-new"]);
    expect(afterStart.minutes).toEqual([cutoff, cutoff + HOUR]);
    expect(startSources).toEqual([undefined, "warm", "warm"]);
    expect(afterHour).toEqual({
      facts: ["d-new"],
      minutes: [cutoff + HOUR],
      requests: ["R-new"],
    });
    expect(hourSources).toEqual([undefined, "warm"]);
    await second.history.stop();
  });
});
