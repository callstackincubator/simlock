import { describe, expect, it } from "vitest";

import { usageOf, usageRangeSearch } from "./usage";
import { usageFiguresOf, usageStatsEmptyOf, usageStatsFullOf } from "./test-support";

const NOW = new Date(2026, 9, 15, 12, 0).getTime();
const view = (stats = usageStatsFullOf(), range: "1h" | "6h" | "24h" | "7d" = "24h") =>
  usageOf(stats, range, NOW);

describe("the Usage view", () => {
  it("shows Requests, Granted, Rejected, Wait p95 and Held p50 from totals, each with the range's unit", () => {
    expect(view().tiles.map((tile) => [tile.label, tile.value, tile.unit])).toEqual([
      ["Requests", "214", "last 24 hours"],
      ["Granted", "209", "last 24 hours"],
      ["Rejected", "5", "last 24 hours"],
      ["Wait p95", "38 s", "last 24 hours"],
      ["Held p50", "4 min 2 s", "last 24 hours"],
    ]);
    expect(view(usageStatsFullOf(), "7d").tiles.every((tile) => tile.unit === "last 7 days")).toBe(
      true,
    );
  });

  it("lists grants by source as warm, booted and provisioned, and unknown only when the answer has it", () => {
    const withUnknown = usageStatsFullOf({
      totals: usageFiguresOf({ bySource: { booted: 41, provisioned: 8, unknown: 6, warm: 160 } }),
    });

    expect(view().bySource.map((entry) => [entry.label, entry.count])).toEqual([
      ["warm", "160"],
      ["booted", "41"],
      ["provisioned", "8"],
    ]);
    expect(view(withUnknown).bySource.map((entry) => [entry.label, entry.count])).toEqual([
      ["warm", "160"],
      ["booted", "41"],
      ["provisioned", "8"],
      ["unknown", "6"],
    ]);
  });

  it("gives the durations table rows Wait, Held, Turnaround, Provisioning and Boot with count, p50, p95 and max as durations, and — for a null figure", () => {
    const nullP95 = usageStatsFullOf({
      totals: usageFiguresOf({ boot: { count: 0, max: null, p50: null, p95: null } }),
    });

    expect(view().durations.map((row) => [row.name, row.count, row.p50, row.p95, row.max])).toEqual(
      [
        ["Wait", "209", "2 s", "38 s", "2 min 10 s"],
        ["Held", "200", "4 min 2 s", "15 min", "1 h"],
        ["Turnaround", "198", "4 min 10 s", "15 min 50 s", "1 h 1 min"],
        ["Provisioning", "8", "21 s", "45 s", "50 s"],
        ["Boot", "41", "11 s", "19 s", "25 s"],
      ],
    );
    const quick = usageStatsFullOf({
      totals: usageFiguresOf({ boot: { count: 3, max: 900, p50: 400, p95: 800 } }),
    });
    expect(view(quick).durations.at(-1)).toMatchObject({ max: "0 s", p50: "0 s", p95: "0 s" });
    expect(view(nullP95).durations.at(-1)).toMatchObject({
      count: "0",
      max: "—",
      name: "Boot",
      p50: "—",
      p95: "—",
    });
  });

  it("lists one rejection row per reason as the daemon spells it, largest count first and ties by reason, and says nothing was rejected when none were", () => {
    const tied = usageStatsFullOf({
      totals: usageFiguresOf({
        rejected: { byReason: { timeout: 2, "no-wait": 2, "z-last": 9, "a-first": 2 }, total: 15 },
      }),
    });

    expect(view(tied).rejections.map((row) => [row.label, row.count])).toEqual([
      ["z-last", "9"],
      ["a-first", "2"],
      ["no-wait", "2"],
      ["timeout", "2"],
    ]);
    expect(view().rejections.map((row) => row.label)).toEqual(["no-wait", "timeout"]);
    expect(view(usageStatsEmptyOf()).rejections).toEqual([]);
  });

  it("lists incidents as Quarantined, Recovered from quarantine, Recovered after a crash and Lost from their four fields", () => {
    expect(view().incidents.map((row) => [row.label, row.count])).toEqual([
      ["Quarantined", "1"],
      ["Recovered from quarantine", "2"],
      ["Recovered after a crash", "3"],
      ["Lost", "4"],
    ]);
  });

  it("shows slots peak, mean to one decimal and max, queue peak and mean, and RAM through formatBytes only when present, with — for a null figure", () => {
    const smallRam = usageStatsFullOf({
      totals: usageFiguresOf({
        utilisation: {
          ram: { limitBytes: 16 * 2 ** 30, meanBytes: 900 * 2 ** 20, peakBytes: 300 * 2 ** 20 },
          slots: { max: null, mean: null, peak: null },
        },
        queue: { meanDepth: null, peakDepth: null },
      }),
    });
    const noRam = usageStatsFullOf({
      totals: usageFiguresOf({
        utilisation: { slots: { max: 9, mean: 5.24, peak: 8 } },
        queue: { meanDepth: 0.46, peakDepth: 3 },
      }),
    });

    expect(view().use).toEqual([
      { label: "Slots", text: "peak 8, mean 5.2, of 9" },
      { label: "RAM", text: "peak 12.0 GiB, mean 900 MiB, of 16.0 GiB" },
      { label: "Queue", text: "peak 3, mean 0.4" },
    ]);
    expect(view(noRam).use).toEqual([
      { label: "Slots", text: "peak 8, mean 5.2, of 9" },
      { label: "Queue", text: "peak 3, mean 0.5" },
    ]);
    expect(view(smallRam).use).toEqual([
      { label: "Slots", text: "peak —, mean —, of —" },
      { label: "RAM", text: "peak 300 MiB, mean 900 MiB, of 16.0 GiB" },
      { label: "Queue", text: "peak —, mean —" },
    ]);
  });

  it("gives the platform table iOS then Android with requests, granted, rejected and wait p95", () => {
    expect(
      view().platforms.map((row) => [
        row.name,
        row.requests,
        row.granted,
        row.rejected,
        row.waitP95,
      ]),
    ).toEqual([
      ["iOS", "120", "118", "2", "30 s"],
      ["Android", "94", "91", "3", "41 s"],
    ]);
  });

  it("names a worker's row by its label or its id where it has none, in the daemon's order, and a single host's one entry is one row", () => {
    const host = usageStatsFullOf({
      workers: [{ ...usageFiguresOf({ requests: 214 }), id: "host" }],
    });

    expect(
      view().workers.map((row) => [row.name, row.requests, row.granted, row.rejected, row.waitP95]),
    ).toEqual([
      ["zeta-mini-01", "85", "80", "5", "33 s"],
      ["w2", "125", "120", "5", "—"],
    ]);
    expect(view(host).workers.map((row) => [row.name, row.requests])).toEqual([["host", "214"]]);
  });

  it("shows a requester's label with its id beside it, its id alone without a label, the agent alone for a gateway's id, and held time in total as a duration, in the daemon's order", () => {
    expect(
      view().requesters.map((row) => [
        row.label,
        row.id,
        row.requests,
        row.granted,
        row.rejected,
        row.held,
      ]),
    ).toEqual([
      ["CI bot", "tok_a", "150", "149", "1", "1 min 1 s"],
      [undefined, "agent-9", "44", "40", "3", "2 h 2 min"],
      [undefined, "agent-7", "20", "20", "1", "5 s"],
    ]);
  });

  it("shows tiles of 0, — for every percentile and mean, and no requester rows for an answer with no requests", () => {
    const empty = view(usageStatsEmptyOf());

    expect(empty.tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ["Requests", "0"],
      ["Granted", "0"],
      ["Rejected", "0"],
      ["Wait p95", "—"],
      ["Held p50", "—"],
    ]);
    expect(empty.durations.flatMap((row) => [row.p50, row.p95, row.max])).toEqual(
      Array.from({ length: 15 }, () => "—"),
    );
    expect(empty.use).toEqual([
      { label: "Slots", text: "peak —, mean —, of —" },
      { label: "Queue", text: "peak —, mean —" },
    ]);
    expect(empty.requesters).toEqual([]);
  });

  it("carries the partial note when the answer is partial, and none otherwise", () => {
    const partial = usageStatsFullOf({
      coversFrom: new Date(2026, 9, 15, 9, 12).getTime(),
      partial: true,
    });

    expect(view().note).toBeUndefined();
    expect(view(partial).note).toBe("Figures cover from today 09:12.");
  });
});

describe("choosing a range on the Usage page", () => {
  it("drops workers-page and requesters-page, keeps both size keys, and writes the new range", () => {
    const search =
      "?range=24h&workers-page=2&workers-size=50&requesters-page=3&requesters-size=100";

    expect(usageRangeSearch(search, "7d")).toBe("?workers-size=50&requesters-size=100&range=7d");
    expect(usageRangeSearch(search, "1h")).toBe("?workers-size=50&requesters-size=100");
  });
});
