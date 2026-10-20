import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import { runDispatch, usageAnswer } from "../../daemon/dispatch.js";
import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";
import { createUsageReader } from "./index.js";
import { DAY, MIN, removeUsageRigs, T0, usageRig } from "../../history/testing.js";

afterEach(removeUsageRigs);

const PLATFORMS = ["ios", "android", "all"] as const;

function seedMinuteRows(database: SqliteDatabase, firstMinute: number, minutes: number): void {
  const insert = database.prepare(
    `INSERT INTO minute_rows (workerId, platform, minute, knownMs, carryUntil,
       slotsUsedPeak, slotsUsedLast, slotsUsedIntegral, slotsMaxPeak, slotsMaxLast, slotsMaxIntegral,
       queueDepthPeak, queueDepthLast, queueDepthIntegral)
     VALUES ('', ?, ?, 60000, NULL, ?, ?, ?, 8, 8, 480000, 1, 0, 30000)`,
  );
  for (let index = 0; index < minutes; index += 1) {
    const level = index % 5;
    for (const platform of PLATFORMS) {
      insert.run(platform, firstMinute + index * MIN, level, level, level * 60_000);
    }
  }
}

function seedRequestRows(database: SqliteDatabase, firstAt: number, spanMs: number, rows: number) {
  const insert = database.prepare(
    `INSERT INTO request_rows (requestId, requester, platform, requestedAt, grantedAt, source,
       leaseId, heldMs, endedAt, endReason, probe)
     VALUES (?, ?, 'ios', ?, ?, 'warm', ?, 5000, ?, 'explicit', 0)`,
  );
  for (let index = 0; index < rows; index += 1) {
    const at = firstAt + Math.floor((index * spanMs) / rows);
    insert.run(`R${index}`, `tok_${index % 20}`, at, at + 400, `L${index}`, at + 5_400);
  }
}

function seedDeviceFacts(database: SqliteDatabase, firstAt: number, spanMs: number, rows: number) {
  const insert = database.prepare(
    `INSERT INTO device_fact_rows (at, kind, durationMs, platform, deviceId)
     VALUES (?, ?, ?, 'ios', ?)`,
  );
  for (let index = 0; index < rows; index += 1) {
    const kind = index % 2 === 0 ? "device.provisioned" : "device.ready";
    insert.run(firstAt + Math.floor((index * spanMs) / rows), kind, 20_000, `dev_${index % 50}`);
  }
}

describe("usage.get read", () => {
  it("over 90 days of seeded rows a 7-day call answers within 500 ms, and the main thread's event-loop delay stays under 50 ms throughout", async () => {
    const rig = await usageRig();
    await rig.close();
    const to = T0 + 90 * DAY;
    const database = await new NodeSqliteOpener().open(rig.historyPath, { readOnly: false });
    try {
      database.exec("BEGIN");
      seedMinuteRows(database, T0, 90 * 24 * 60);
      seedRequestRows(database, T0, 90 * DAY, 100_000);
      seedDeviceFacts(database, T0, 90 * DAY, 10_000);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const reader = createUsageReader(rig.deps({ opened: () => true }));
    // why: a source run starts the read thread by transpiling its modules, a cost a built daemon does not pay and a slow runner multiplies; one small read starts it before the timed call.
    await reader.get({ from: to - DAY, to });
    const delay = monitorEventLoopDelay({ resolution: 5 });

    delay.enable();
    const startedAt = performance.now();
    const result = await reader.get({ from: to - 7 * DAY, to });
    const elapsed = performance.now() - startedAt;
    delay.disable();
    await reader.stop();

    expect(result.kind).toBe("figures");
    expect(elapsed).toBeLessThan(500);
    expect(delay.max / 1e6).toBeLessThan(50);
    if (result.kind === "figures") expect(result.usage.totals.requests).toBeGreaterThan(5_000);
  });

  it("a 100,000-entry ledger answer over the seeded rows returns through the dispatcher, output parse included, within 2.5 s", async () => {
    const rig = await usageRig();
    await rig.close();
    const to = T0 + 2 * DAY;
    const database = await new NodeSqliteOpener().open(rig.historyPath, { readOnly: false });
    try {
      database.exec("BEGIN");
      seedRequestRows(database, T0, DAY, 100_000);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const reader = createUsageReader(rig.deps({ opened: () => true }));
    const admin = { manageEventSubscription: () => 0, principal: "admin", role: "admin" } as never;
    const pipeline = {
      handlers: {
        "usage.get": (input: { readonly from: number; readonly to: number }) =>
          usageAnswer(reader.get({ ...input, includeLedger: true })),
      },
    };
    // why: a source run starts the read thread by transpiling its modules, a cost a built daemon does not pay; one small read starts it before the timed call.
    await reader.get({ from: to - MIN, to });

    const startedAt = performance.now();
    const answer = await runDispatch(
      "usage.get",
      { from: T0, includeLedger: true, to },
      admin,
      pipeline,
    );
    const elapsed = performance.now() - startedAt;
    await reader.stop();

    expect(answer.requests).toHaveLength(100_000);
    expect(elapsed).toBeLessThan(2_500);
  }, 60_000);
});
