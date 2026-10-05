import { describe, expect, it } from "vitest";

import type { UsageFigures, UsageOutput } from "../contract/index.js";
import { formatUsage } from "./stats.js";

const NONE = { count: 0, max: null, p50: null, p95: null };

function figuresFixture(overrides: Partial<UsageFigures> = {}): UsageFigures {
  return {
    boot: NONE,
    bySource: { booted: 0, provisioned: 0, warm: 0 },
    failures: { byEvent: {} },
    granted: 0,
    held: NONE,
    incidents: { crashRecovered: 0, lost: 0, quarantineRecovered: 0, quarantined: 0 },
    provisioning: NONE,
    queue: { meanDepth: null, peakDepth: null },
    rejected: { byReason: {}, total: 0 },
    requests: 0,
    turnaround: NONE,
    utilisation: { slots: { max: null, mean: null, peak: null } },
    wait: NONE,
    ...overrides,
  };
}

function usageFixture(overrides: Partial<UsageOutput> = {}): UsageOutput {
  return {
    bucketMs: 900_000,
    coversFrom: Date.parse("2026-10-04T10:00:00.000Z"),
    partial: false,
    platforms: { android: figuresFixture(), ios: figuresFixture() },
    requesters: [],
    series: [],
    totals: figuresFixture(),
    window: {
      from: Date.parse("2026-10-04T10:00:00.000Z"),
      to: Date.parse("2026-10-05T10:00:00.000Z"),
    },
    workers: [],
    ...overrides,
  };
}

const BUSY = figuresFixture({
  boot: { count: 2, max: 40_000, p50: 20_000, p95: 40_000 },
  bySource: { booted: 3, provisioned: 1, warm: 6 },
  failures: { byEvent: { "device.purge-failed": 2 } },
  granted: 10,
  held: { count: 9, max: 3_725_000, p50: 300_000, p95: 1_800_000 },
  incidents: { crashRecovered: 1, lost: 4, quarantineRecovered: 3, quarantined: 2 },
  provisioning: { count: 1, max: 90_000, p50: 90_000, p95: 90_000 },
  queue: { meanDepth: 0.4, peakDepth: 2 },
  rejected: { byReason: { "no-wait": 1, timeout: 1 }, total: 2 },
  requests: 12,
  turnaround: { count: 9, max: 3_800_000, p50: 310_000, p95: 1_900_000 },
  utilisation: {
    ram: { limitBytes: 16 * 1024 ** 3, meanBytes: 1024 ** 3, peakBytes: 2 * 1024 ** 3 },
    slots: { max: 4, mean: 1.5, peak: 3 },
  },
  wait: { count: 11, max: 9_100, p50: 1_200, p95: 4_000 },
});

describe("formatUsage", () => {
  it("opens with the window and, when the history falls short of it, the line that says where the figures start", () => {
    const partial = formatUsage(
      usageFixture({ coversFrom: Date.parse("2026-10-05T09:59:00.000Z"), partial: true }),
    ).split("\n");
    const whole = formatUsage(usageFixture());

    expect(partial[0]).toBe("Usage from 2026-10-04T10:00:00.000Z to 2026-10-05T10:00:00.000Z");
    expect(partial[1]).toBe(
      "Figures cover from 2026-10-05T09:59:00.000Z: the history does not reach back to the start of the window.",
    );
    expect(whole).not.toContain("Figures cover from");
  });

  it("prints every total on a line of its own", () => {
    const lines = formatUsage(usageFixture({ totals: BUSY })).split("\n");

    expect(lines).toContain("Totals");
    expect(lines).toContain("  Requests:     12 (10 granted, 2 rejected)");
    expect(lines).toContain("  Granted:      warm 6, booted 3, provisioned 1");
    expect(lines).toContain("  Rejected:     no-wait 1, timeout 1");
    expect(lines).toContain("  Wait:         p50 1.2s, p95 4s, max 9.1s (11 samples)");
    expect(lines).toContain("  Held:         p50 5m 0s, p95 30m 0s, max 1h 2m (9 samples)");
    expect(lines).toContain("  Turnaround:   p50 5m 10s, p95 31m 40s, max 1h 3m (9 samples)");
    expect(lines).toContain("  Provisioning: p50 1m 30s, p95 1m 30s, max 1m 30s (1 sample)");
    expect(lines).toContain("  Boot:         p50 20s, p95 40s, max 40s (2 samples)");
    expect(lines).toContain("  Slots:        peak 3 of 4, mean 1.5");
    expect(lines).toContain("  RAM:          peak 2.0 GiB of 16.0 GiB, mean 1.0 GiB");
    expect(lines).toContain("  Queue:        peak depth 2, mean 0.4");
    expect(lines).toContain(
      "  Incidents:    2 quarantined, 1 recovered after a crash, 3 recovered from quarantine, 4 lost",
    );
    expect(lines).toContain("  Failures:     device.purge-failed 2");
  });

  it("says plainly what it has no figure for, and leaves out rows it has nothing to say in", () => {
    const text = formatUsage(usageFixture());

    expect(text).toContain("  Requests:     0 (0 granted, 0 rejected)");
    expect(text).toContain("  Wait:         no samples");
    expect(text).toContain("  Slots:        not known");
    expect(text).toContain("  Queue:        not known");
    expect(text).not.toContain("RAM:");
    expect(text).not.toContain("Failures:");
    expect(text).not.toContain("Rejected:");
    expect(text).not.toContain("Granted:");
    expect(text).not.toContain("Workers");
    expect(text).not.toContain("Requesters");
  });

  it("prints a row for each platform, each worker with its label, and each requester with its label", () => {
    const lines = formatUsage(
      usageFixture({
        platforms: { android: figuresFixture(), ios: BUSY },
        requesters: [
          {
            granted: 2,
            heldTotalMs: 725_000,
            id: "tok_a",
            label: "ci-bot",
            rejected: 1,
            requests: 3,
          },
          { granted: 0, heldTotalMs: 0, id: "tok_b", rejected: 0, requests: 1 },
        ],
        totals: BUSY,
        workers: [
          { ...BUSY, id: "wrk_1", label: "mac-mini-1" },
          { ...figuresFixture(), id: "wrk_2" },
        ],
      }),
    ).split("\n");

    expect(lines).toContain("Platforms");
    expect(lines).toContain(
      "  ios      12 requests, 10 granted, 2 rejected, wait p50 1.2s, held p50 5m 0s, slots peak 3",
    );
    expect(lines).toContain(
      "  android  0 requests, 0 granted, 0 rejected, wait p50 -, held p50 -, slots peak -",
    );
    expect(lines).toContain("Workers");
    expect(lines).toContain(
      "  mac-mini-1 (wrk_1)  12 requests, 10 granted, 2 rejected, wait p50 1.2s, held p50 5m 0s, slots peak 3",
    );
    expect(lines).toContain(
      "  wrk_2               0 requests, 0 granted, 0 rejected, wait p50 -, held p50 -, slots peak -",
    );
    expect(lines).toContain("Requesters");
    expect(lines).toContain("  ci-bot (tok_a)  3 requests, 2 granted, 1 rejected, held 12m 5s");
    expect(lines).toContain("  tok_b           1 request, 0 granted, 0 rejected, held 0s");
  });
});

const PLATFORM_ROW = "0 requests, 0 granted, 0 rejected, wait p50 -, held p50 -, slots peak -";
const TOTAL_ROWS = [
  "Totals",
  "  Requests:     0 (0 granted, 0 rejected)",
  "  Wait:         no samples",
  "  Held:         no samples",
  "  Turnaround:   no samples",
  "  Provisioning: no samples",
  "  Boot:         no samples",
  "  Slots:        not known",
  "  Queue:        not known",
  "  Incidents:    0 quarantined, 0 recovered after a crash, 0 recovered from quarantine, 0 lost",
];

describe("formatUsage layout", () => {
  it("separates the sections with one blank line each, in the order of the header, totals, platforms, workers and requesters", () => {
    const text = formatUsage(
      usageFixture({
        coversFrom: Date.parse("2026-10-05T09:59:00.000Z"),
        partial: true,
        requesters: [{ granted: 0, heldTotalMs: 0, id: "tok_b", rejected: 0, requests: 1 }],
        workers: [{ ...figuresFixture(), id: "wrk_2" }],
      }),
    );

    expect(text).toBe(
      [
        "Usage from 2026-10-04T10:00:00.000Z to 2026-10-05T10:00:00.000Z",
        "Figures cover from 2026-10-05T09:59:00.000Z: the history does not reach back to the start of the window.",
        "",
        ...TOTAL_ROWS,
        "",
        "Platforms",
        `  android  ${PLATFORM_ROW}`,
        `  ios      ${PLATFORM_ROW}`,
        "",
        "Workers",
        `  wrk_2  ${PLATFORM_ROW}`,
        "",
        "Requesters",
        "  tok_b  1 request, 0 granted, 0 rejected, held 0s",
      ].join("\n"),
    );
  });

  it("prints a whole report without the optional sections when there are no workers or requesters", () => {
    expect(formatUsage(usageFixture())).toBe(
      [
        "Usage from 2026-10-04T10:00:00.000Z to 2026-10-05T10:00:00.000Z",
        "",
        ...TOTAL_ROWS,
        "",
        "Platforms",
        `  android  ${PLATFORM_ROW}`,
        `  ios      ${PLATFORM_ROW}`,
      ].join("\n"),
    );
  });
});

describe("formatUsage rows that depend on the figures", () => {
  it("lists the error codes and the rejection reasons by name, whatever order they arrived in", () => {
    const lines = formatUsage(
      usageFixture({
        totals: figuresFixture({
          failures: { byEvent: { "c.zed": 1, "a.alpha": 2, "b.mid": 3 } },
          rejected: { byReason: { timeout: 1, "no-wait": 2, capacity: 3 }, total: 6 },
        }),
      }),
    ).split("\n");

    expect(lines).toContain("  Failures:     a.alpha 2, b.mid 3, c.zed 1");
    expect(lines).toContain("  Rejected:     capacity 3, no-wait 2, timeout 1");
  });

  it("prints the Failures row only when there are failure events", () => {
    const without = formatUsage(usageFixture());
    const withOne = formatUsage(
      usageFixture({ totals: figuresFixture({ failures: { byEvent: { "x.y": 1 } } }) }),
    );

    expect(without.split("\n").some((line) => line.startsWith("  Failures:"))).toBe(false);
    expect(withOne.split("\n")).toContain("  Failures:     x.y 1");
  });

  it("prints the Granted row only when something was granted", () => {
    const withGrant = formatUsage(
      usageFixture({
        totals: figuresFixture({ bySource: { booted: 0, provisioned: 0, warm: 1 }, granted: 1 }),
      }),
    ).split("\n");
    const without = formatUsage(usageFixture()).split("\n");

    expect(withGrant).toContain("  Granted:      warm 1, booted 0, provisioned 0");
    expect(without.some((line) => line.startsWith("  Granted:"))).toBe(false);
  });

  it("prints the Rejected row only when something was rejected", () => {
    const withReject = formatUsage(
      usageFixture({
        totals: figuresFixture({ rejected: { byReason: { timeout: 1 }, total: 1 } }),
      }),
    ).split("\n");
    const without = formatUsage(usageFixture()).split("\n");

    expect(withReject).toContain("  Rejected:     timeout 1");
    expect(without.some((line) => line.startsWith("  Rejected:"))).toBe(false);
  });

  it("prints the RAM row only when the figures carry RAM", () => {
    const withRam = formatUsage(
      usageFixture({
        totals: figuresFixture({
          utilisation: {
            ram: { limitBytes: 8 * 1024 ** 3, meanBytes: 0, peakBytes: 1024 ** 3 },
            slots: { max: null, mean: null, peak: null },
          },
        }),
      }),
    ).split("\n");
    const without = formatUsage(usageFixture()).split("\n");

    expect(withRam).toContain("  RAM:          peak 1.0 GiB of 8.0 GiB, mean 0.0 GiB");
    expect(without.some((line) => line.startsWith("  RAM:"))).toBe(false);
  });

  it.each([
    ["peak", { max: 4, mean: 1.5, peak: null }],
    ["max", { max: null, mean: 1.5, peak: 3 }],
    ["mean", { max: 4, mean: null, peak: 3 }],
  ])("says slots are not known when only the slot %s is missing", (_name, slots) => {
    const lines = formatUsage(
      usageFixture({ totals: figuresFixture({ utilisation: { slots } }) }),
    ).split("\n");

    expect(lines).toContain("  Slots:        not known");
  });

  it.each([
    ["peak depth", { meanDepth: 0.4, peakDepth: null }],
    ["mean depth", { meanDepth: null, peakDepth: 2 }],
  ])("says the queue is not known when only the queue %s is missing", (_name, queue) => {
    const lines = formatUsage(usageFixture({ totals: figuresFixture({ queue }) })).split("\n");

    expect(lines).toContain("  Queue:        not known");
  });

  it.each([
    ["p50", { count: 1, max: 2, p50: null, p95: 1 }],
    ["p95", { count: 1, max: 2, p50: 1, p95: null }],
    ["max", { count: 1, max: null, p50: 1, p95: 2 }],
  ])("says there are no samples when only the %s is missing", (_name, wait) => {
    const lines = formatUsage(usageFixture({ totals: figuresFixture({ wait }) })).split("\n");

    expect(lines).toContain("  Wait:         no samples");
  });
});

describe("formatUsage durations", () => {
  const waitP50 = (ms: number): string => {
    const lines = formatUsage(
      usageFixture({
        totals: figuresFixture({ wait: { count: 1, max: ms, p50: ms, p95: ms } }),
      }),
    ).split("\n");
    const line = lines.find((candidate) => candidate.startsWith("  Wait:"));
    return (line ?? "").replace(/^ {2}Wait: +p50 /, "").replace(/,.*$/, "");
  };

  it.each([
    [0, "0s"],
    [250, "250ms"],
    [999, "999ms"],
    [1_000, "1s"],
    [59_999, "60s"],
    [60_000, "1m 0s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 0m"],
    [7_380_000, "2h 3m"],
  ])("prints %i ms as %s", (ms, expected) => {
    expect(waitP50(ms)).toBe(expected);
  });
});
