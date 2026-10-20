import type { UsageOutput } from "../../../src/contract/index";

type UsageFigures = UsageOutput["totals"];

export interface StatsShape {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  readonly granted?: number;
  readonly waitP95?: number | null;
  readonly partial?: boolean;
  readonly coversFrom?: number;
  readonly series?: readonly {
    readonly at: number;
    readonly leasesHeld: number | null;
    readonly queueDepth: number | null;
    readonly slotsUsed: number | null;
  }[];
}

// why: a stats answer carries many figures the console never reads; a test names only the ones the
// console shows, and the rest stay out of the way.
export function statsOf(shape: StatsShape): UsageOutput {
  return {
    bucketMs: shape.bucketMs,
    coversFrom: shape.coversFrom ?? shape.from,
    partial: shape.partial ?? false,
    series: (shape.series ?? []).map((point) => ({
      ...point,
      slotsMax: null,
      waiting: null,
    })),
    totals: {
      granted: shape.granted ?? 0,
      wait: { count: 0, max: null, p50: null, p95: shape.waitP95 ?? null },
    },
    window: { from: shape.from, to: shape.to },
  } as unknown as UsageOutput;
}

const MIB = 2 ** 20;
const GIB = 2 ** 30;

function samples(count: number, p50: number | null, p95: number | null, max: number | null) {
  return { count, max, p50, p95 };
}

// why: a stats answer for the Usage page carries every figure it shows, each different from the
// others, so a figure read from the wrong field cannot match by luck.
export function usageFiguresOf(over: Partial<UsageFigures> = {}): UsageFigures {
  return {
    boot: samples(41, 11_000, 19_000, 25_000),
    bySource: { booted: 41, provisioned: 8, warm: 160 },
    declined: 777,
    failures: { byEvent: { "device.recovery-failed": 999 } },
    granted: 209,
    held: samples(200, 242_000, 900_000, 3_600_000),
    incidents: { crashRecovered: 3, lost: 4, quarantineRecovered: 2, quarantined: 1 },
    probes: 888,
    provisioning: samples(8, 21_000, 45_000, 50_000),
    queue: { meanDepth: 0.4, peakDepth: 3 },
    rejected: { byReason: { "no-wait": 3, timeout: 2 }, total: 5 },
    requests: 214,
    turnaround: samples(198, 250_000, 950_000, 3_700_000),
    utilisation: {
      ram: { limitBytes: 16 * GIB, meanBytes: 900 * MIB, peakBytes: 12 * GIB },
      slots: { max: 9, mean: 5.24, peak: 8 },
    },
    wait: samples(209, 2_000, 38_000, 130_000),
    ...over,
  };
}

export function usageStatsFullOf(over: Partial<UsageOutput> = {}): UsageOutput {
  return {
    bucketMs: 60_000,
    coversFrom: Date.parse("2026-10-14T12:00:00Z"),
    partial: false,
    platforms: {
      android: usageFiguresOf({
        granted: 91,
        rejected: { byReason: {}, total: 3 },
        requests: 94,
        wait: samples(91, 1_000, 41_000, 60_000),
      }),
      ios: usageFiguresOf({
        granted: 118,
        rejected: { byReason: {}, total: 2 },
        requests: 120,
        wait: samples(118, 1_000, 30_000, 60_000),
      }),
    },
    requesters: [
      {
        granted: 149,
        heldTotalMs: 61_000,
        id: "tok_a",
        label: "CI bot",
        rejected: 1,
        requests: 150,
      },
      { granted: 40, heldTotalMs: 7_320_000, id: "agent-9", rejected: 3, requests: 44 },
      { granted: 20, heldTotalMs: 5_000, id: "gw:gwA:agent-7", rejected: 1, requests: 20 },
    ],
    series: [],
    totals: usageFiguresOf(),
    window: { from: Date.parse("2026-10-14T12:00:00Z"), to: Date.parse("2026-10-15T12:00:00Z") },
    workers: [
      {
        ...usageFiguresOf({
          granted: 80,
          requests: 85,
          wait: samples(80, 1_000, 33_000, 60_000),
        }),
        id: "w9",
        label: "zeta-mini-01",
      },
      {
        ...usageFiguresOf({ granted: 120, requests: 125, wait: samples(120, 1_000, null, 60_000) }),
        id: "w2",
      },
    ],
    ...over,
  };
}

export function usageStatsEmptyOf(): UsageOutput {
  const none = samples(0, null, null, null);
  const { probes: _probes, ...bare } = usageFiguresOf({
    boot: none,
    bySource: { booted: 0, provisioned: 0, warm: 0 },
    declined: 0,
    failures: { byEvent: {} },
    granted: 0,
    held: none,
    incidents: { crashRecovered: 0, lost: 0, quarantineRecovered: 0, quarantined: 0 },
    provisioning: none,
    queue: { meanDepth: null, peakDepth: null },
    rejected: { byReason: {}, total: 0 },
    requests: 0,
    turnaround: none,
    utilisation: { slots: { max: null, mean: null, peak: null } },
    wait: none,
  });
  return usageStatsFullOf({
    platforms: { android: bare, ios: bare },
    requesters: [],
    totals: bare,
    workers: [{ ...bare, id: "host" }],
  });
}
