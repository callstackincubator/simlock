import { describe, expect, it } from "vitest";

import { figuresOf, waitTile } from "./figures";
import type { ConsoleRange } from "./range";
import { statsOf } from "./test-support";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function local(day: number, hour: number, minute = 0): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

const NOW = local(15, 14, 30);

describe("the Wait p95 tile", () => {
  it("shows totals.wait.p95 in milliseconds below 1 second, as a duration from 1 second, and — when it is null", () => {
    const shown = [0, 400, 999, 1_000, 38_000, 130_000, null].map((waitP95) =>
      waitTile(statsOf({ bucketMs: MINUTE, from: NOW - HOUR, to: NOW, waitP95 }), "1h"),
    );

    expect(shown.map((tile) => [tile.label, tile.value])).toEqual([
      ["Wait p95", "0 ms"],
      ["Wait p95", "400 ms"],
      ["Wait p95", "999 ms"],
      ["Wait p95", "1 s"],
      ["Wait p95", "38 s"],
      ["Wait p95", "2 min 10 s"],
      ["Wait p95", "—"],
    ]);
  });

  it("names the range as its unit", () => {
    const stats = statsOf({ bucketMs: MINUTE, from: NOW - HOUR, to: NOW, waitP95: 400 });

    const units = (["1h", "6h", "24h", "7d"] as const).map((range) => waitTile(stats, range).unit);

    expect(units).toEqual(["last hour", "last 6 hours", "last 24 hours", "last 7 days"]);
  });
});

describe("the figures drawn from a stats answer", () => {
  it("takes the three charts from leasesHeld, queueDepth and slotsUsed of each point in order, and keeps a null point null", () => {
    const from = local(15, 12);
    const stats = statsOf({
      bucketMs: MINUTE,
      from,
      series: [
        { at: from + MINUTE, leasesHeld: 1, queueDepth: 4, slotsUsed: 7 },
        { at: from + 2 * MINUTE, leasesHeld: 2, queueDepth: null, slotsUsed: 8 },
        { at: from + 3 * MINUTE, leasesHeld: null, queueDepth: 6, slotsUsed: 9 },
      ],
      to: from + 3 * MINUTE,
    });

    const { charts } = figuresOf(stats, "1h", NOW);

    expect(charts.map((chart) => [chart.key, chart.points.map((point) => point.count)])).toEqual([
      ["leasesHeld", [1, 2, null]],
      ["queueDepth", [4, null, 6]],
      ["slotsUsed", [7, 8, 9]],
    ]);
    expect(charts.map((chart) => chart.points.map((point) => point.at))).toEqual(
      charts.map(() => [from + MINUTE, from + 2 * MINUTE, from + 3 * MINUTE]),
    );
  });

  it("titles each chart with the range's unit", () => {
    const stats = statsOf({ bucketMs: MINUTE, from: NOW - HOUR, to: NOW });

    const titles = (["1h", "7d"] as const).map((range) =>
      figuresOf(stats, range, NOW).charts.map((chart) => chart.title),
    );

    expect(titles).toEqual([
      [
        "Leases held, last hour",
        "Requests in the queue, last hour",
        "Device slots in use, last hour",
      ],
      [
        "Leases held, last 7 days",
        "Requests in the queue, last 7 days",
        "Device slots in use, last 7 days",
      ],
    ]);
  });

  it("labels a point with its bucket's start as HH:MM, and a short last point with the previous point's end", () => {
    const cases: readonly [number, number, number][] = [
      [MINUTE, local(15, 13, 0), local(15, 13, 2) + 30_000],
      [5 * MINUTE, local(15, 12, 0), local(15, 12, 12)],
      [15 * MINUTE, local(15, 10, 0), local(15, 11, 0)],
      [HOUR, local(15, 8, 0), local(15, 11, 0)],
    ];

    const labels = cases.map(([bucketMs, from, to]) => {
      const series = [];
      for (let at = from + bucketMs; at < to; at += bucketMs) {
        series.push({ at, leasesHeld: 1, queueDepth: 1, slotsUsed: 1 });
      }
      series.push({ at: to, leasesHeld: 1, queueDepth: 1, slotsUsed: 1 });
      const stats = statsOf({ bucketMs, from, series, to });
      return figuresOf(stats, "24h", NOW).charts[0]?.points.map((point) => point.label);
    });

    expect(labels).toEqual([
      ["13:00", "13:01", "13:02"],
      ["12:00", "12:05", "12:10"],
      ["10:00", "10:15", "10:30", "10:45"],
      ["08:00", "09:00", "10:00"],
    ]);
  });

  it("leaves the day out of a 24 hour window whose start the daemon floored to its bucket", () => {
    const bucketMs = 15 * MINUTE;
    const to = local(15, 14, 30);
    const from = local(14, 14, 30) - 10 * MINUTE;
    const series = Array.from({ length: 97 }, (_, index) => ({
      at: Math.min(from + (index + 1) * bucketMs, to),
      leasesHeld: 1,
      queueDepth: 1,
      slotsUsed: 1,
    }));
    const stats = statsOf({ bucketMs, from, series, to });

    const { points } = figuresOf(stats, "24h", to).charts[0] ?? { points: [] };

    expect(points.map((point) => point.label).slice(0, 2)).toEqual(["14:20", "14:35"]);
  });

  it("says Now with the newest bucket that has a figure, when the last one has none yet", () => {
    const from = local(15, 12);
    const stats = statsOf({
      bucketMs: MINUTE,
      from,
      series: [2, 4, null].map((count, index) => ({
        at: from + (index + 1) * MINUTE,
        leasesHeld: count,
        queueDepth: count,
        slotsUsed: count,
      })),
      to: from + 3 * MINUTE,
    });

    const { charts } = figuresOf(stats, "1h", NOW);

    expect(charts[0]?.summary).toBe("Now 4; highest 4 at 12:01; lowest 2 at 12:00.");
  });

  it("carries the day in a label when the window is 7 days", () => {
    const from = local(8, 14);
    const to = local(15, 15);
    const series = Array.from({ length: 169 }, (_, index) => ({
      at: Math.min(from + (index + 1) * HOUR, to),
      leasesHeld: 1,
      queueDepth: 1,
      slotsUsed: 1,
    }));
    const stats = statsOf({ bucketMs: HOUR, from, series, to });

    const { points } = figuresOf(stats, "7d", local(15, 15, 30)).charts[0] ?? { points: [] };

    expect(points[144]?.label).toBe("yesterday 14:00");
    expect(points[168]?.label).toBe("today 14:00");
  });

  it("says in each chart's summary line now, highest and lowest, skipping null points", () => {
    const from = local(15, 12);
    const counts = [2, null, 5, 1, 3];
    const stats = statsOf({
      bucketMs: MINUTE,
      from,
      series: counts.map((count, index) => ({
        at: from + (index + 1) * MINUTE,
        leasesHeld: count,
        queueDepth: null,
        slotsUsed: count === null ? null : count * 10,
      })),
      to: from + 5 * MINUTE,
    });

    const { charts } = figuresOf(stats, "1h", NOW);

    expect(charts.map((chart) => chart.summary)).toEqual([
      "Now 3; highest 5 at 12:02; lowest 1 at 12:03.",
      "",
      "Now 30; highest 50 at 12:02; lowest 10 at 12:03.",
    ]);
  });

  it("reads Figures cover from <day> <HH:MM>. from coversFrom when partial, and has no note otherwise", () => {
    const base = { bucketMs: HOUR, from: local(8, 14), to: local(15, 14) };

    const notes = [
      statsOf({ ...base, coversFrom: local(15, 9, 5), partial: true }),
      statsOf({ ...base, coversFrom: local(14, 23, 45), partial: true }),
      statsOf({ ...base, coversFrom: local(15, 9, 5), partial: false }),
    ].map((stats) => figuresOf(stats, "7d" satisfies ConsoleRange, NOW).note);

    expect(notes).toEqual([
      "Figures cover from today 09:05.",
      "Figures cover from yesterday 23:45.",
      undefined,
    ]);
  });
});
