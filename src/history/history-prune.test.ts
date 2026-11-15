import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { type EventEnvelope } from "../bus/index.js";
import { plainProjection } from "./testing.js";
import {
  NOW,
  HOUR,
  directories,
  rig,
  stopping,
  relayed,
  levelRecords,
  settle,
  sizeOf,
} from "./test-history.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("createEventHistory", () => {
  it("prune deletes event rows older than retention and keeps one stamped exactly at the cutoff", async () => {
    const rigged = await rig();
    const retention = 2 * HOUR;
    const cutoff = NOW - retention;
    relayed(rigged.bus, "evt_old", cutoff - 1);
    const atCutoff = relayed(rigged.bus, "evt_cutoff", cutoff);
    const newer = relayed(rigged.bus, "evt_newer", cutoff + 1);
    const history = rigged.history({ retention });

    await history.start();
    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(replayed).toEqual([atCutoff, newer]);
  });

  it("prune deletes the oldest event rows, 1 000 per step, until their stored size fits maxBytes, keeps the newest, and after the prune history.db plus its -wal is smaller than before it and the -wal is empty", async () => {
    const rigged = await rig({ capacity: 10 });
    const writer = rigged.history();
    await writer.start();
    const padding = "é".repeat(1_000);
    const emitted: EventEnvelope[] = [];
    for (let index = 0; index < 2_500; index += 1) {
      rigged.clock.advance(1);
      emitted.push(stopping(rigged.bus, `${padding}${index}`));
    }
    await writer.stop();
    const storedSize = (envelope: EventEnvelope): number =>
      Buffer.byteLength(JSON.stringify(envelope), "utf8");
    const newest1200 = emitted
      .slice(-1_200)
      .reduce((sum, envelope) => sum + storedSize(envelope), 0);
    const diskSize = async (): Promise<number> =>
      (await sizeOf(rigged.dbPath)) + (await sizeOf(`${rigged.dbPath}-wal`));
    const before = await diskSize();
    const next = await rig({ directory: rigged.directory });
    const history = next.history({ maxBytes: newest1200 });

    await history.start();
    const kept = await history.replay({ sinceTs: 0 });
    // why: read while the file is open; closing it would drop the -wal and hide a missing checkpoint
    const after = await diskSize();
    const walAfter = await sizeOf(`${rigged.dbPath}-wal`);
    await history.stop();

    expect(kept).toEqual(emitted.slice(-500));
    expect(after).toBeLessThan(before);
    expect(walAfter).toBe(0);
  });

  it("the hourly prune counts the size of events written since start(), so it trims the oldest 1 000 at a time to maxBytes and the next hour trims nothing more", async () => {
    const rigged = await rig({ capacity: 10 });
    const storedSize = (envelope: EventEnvelope): number =>
      Buffer.byteLength(JSON.stringify(envelope), "utf8");
    const probe = stopping(rigged.bus, "0000");
    const history = rigged.history({ maxBytes: storedSize(probe) * 1_200 });
    await history.start();
    const emitted: EventEnvelope[] = [probe];
    for (let index = 0; index < 2_500; index += 1) {
      rigged.clock.advance(1);
      emitted.push(stopping(rigged.bus, String(index).padStart(4, "0")));
    }

    rigged.clock.advance(HOUR);
    await settle();
    const kept = await history.replay({ sinceTs: 0 });
    rigged.clock.advance(HOUR);
    await settle();
    const keptAfterSecondHour = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(kept).toEqual(emitted.slice(-501));
    expect(keptAfterSecondHour).toEqual(emitted.slice(-501));
  });

  it("prune runs again one hour after start() on the clock, not before, and stop() cancels it", async () => {
    const rigged = await rig();
    const history = rigged.history({ retention: HOUR / 2 });
    await history.start();
    const old = stopping(rigged.bus, "old");

    rigged.clock.advance(HOUR - 1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([old]);
    rigged.clock.advance(1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([]);

    const second = stopping(rigged.bus, "second");
    rigged.clock.advance(HOUR - 1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([second]);
    rigged.clock.advance(1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([]);

    await history.stop();
    expect(rigged.clock.pendingTimerCount).toBe(0);
  });

  it("a prune step that throws logs one warning, writing goes on, and the next prune tries again", async () => {
    const rigged = await rig();
    let attempts = 0;
    const definition = plainProjection("failing-prune", () => ({
      apply: () => undefined,
      prune: () => {
        attempts += 1;
        throw new Error("prune failed");
      },
    }));
    const history = rigged.history({ projections: [definition] });
    await history.start();
    const attemptsAtStart = attempts;
    const warningsAtStart = levelRecords(rigged, "warn");

    rigged.clock.advance(HOUR);
    await settle();
    const afterFirst = attempts - attemptsAtStart;
    const warnings = levelRecords(rigged, "warn") - warningsAtStart;
    const later = stopping(rigged.bus, "later");
    rigged.clock.advance(HOUR);
    await settle();

    expect(afterFirst).toBe(1);
    expect(warnings).toBe(1);
    expect(attempts - attemptsAtStart).toBe(2);
    expect(history.status().writing).toBe(true);
    expect((await history.replay({ sinceTs: 0 })).at(-1)).toEqual(later);
    await history.stop();
  });

  it("a prune that fails after its age delete committed leaves the stored size true, so the next prune keeps rows under maxBytes", async () => {
    const rigged = await rig();
    const retention = 2 * HOUR;
    const old = [1, 2, 3].map((index) =>
      relayed(rigged.bus, `evt_old${index}`, NOW - 3 * HOUR + index),
    );
    const size = Buffer.byteLength(JSON.stringify(old[0]), "utf8");
    let attempts = 0;
    const definition = plainProjection("fails-once", () => ({
      apply: () => undefined,
      prune: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("prune failed");
      },
    }));
    const history = rigged.history({ maxBytes: size * 4, projections: [definition], retention });
    await history.start();
    const fresh = [1, 2, 3].map((index) => relayed(rigged.bus, `evt_new${index}`, NOW + index));

    rigged.clock.advance(HOUR);
    await settle();
    const kept = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(attempts).toBe(2);
    expect(kept).toEqual(fresh);
  });

  it("skips on replay a row whose id the envelope schema refuses", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const good = relayed(rigged.bus, "evt_good", NOW);
    relayed(rigged.bus, "not an id!", NOW + 1);
    const after = relayed(rigged.bus, "evt_after", NOW + 2);

    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();
    expect(replayed).toEqual([good, after]);
  });
});
