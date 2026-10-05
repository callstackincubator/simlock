import { describe, expect, it } from "vitest";

import type { UsageFigures, UsageOutput } from "../contract/index.js";
import { formatUsage } from "./stats.js";

const NONE = { count: 0, max: null, p50: null, p95: null };

function figuresFixture(overrides: Partial<UsageFigures> = {}): UsageFigures {
  return {
    boot: NONE,
    bySource: { booted: 0, provisioned: 0, warm: 0 },
    errors: { byCode: {} },
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
  errors: { byCode: { "device.purge-failed": 2 } },
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
    expect(lines).toContain("  Errors:       device.purge-failed 2");
  });

  it("says plainly what it has no figure for, and leaves out rows it has nothing to say in", () => {
    const text = formatUsage(usageFixture());

    expect(text).toContain("  Requests:     0 (0 granted, 0 rejected)");
    expect(text).toContain("  Wait:         no samples");
    expect(text).toContain("  Slots:        not known");
    expect(text).toContain("  Queue:        not known");
    expect(text).not.toContain("RAM:");
    expect(text).not.toContain("Errors:");
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
