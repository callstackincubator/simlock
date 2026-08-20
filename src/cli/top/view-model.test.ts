import { describe, expect, it } from "vitest";

import {
  buildMeter,
  formatCoarseDuration,
  formatDuration,
  formatRelativeAge,
  meterLayout,
  resolveWidth,
  parseIdleShutdownAfterMs,
  parseStatus,
  summarizeEvent,
  type Capacity,
  type CapacityUsage,
} from "./view-model.js";

describe("parseStatus: device classification", () => {
  it("classifies a leased device, resolving the agent from the matching lease", () => {
    const vm = parseStatus(
      {
        devices: [device("dev_1", "leased", { spec: { model: "iPhone 17 Pro" } })],
        leases: [lease("dev_1", "agent-a", { grantedAt: 900 })],
      },
      { now: 1_000 },
    );
    expect(vm.devices).toEqual([
      expect.objectContaining({ agent: "agent-a", forMs: 100, id: "dev_1", state: "leased" }),
    ]);
  });

  it("classifies a ready device with no lease as warm", () => {
    const vm = parseStatus(
      { devices: [device("dev_1", "ready", { lastLeaseEndedAt: 700 })], leases: [] },
      { now: 1_000 },
    );
    expect(vm.devices).toEqual([expect.objectContaining({ forMs: 300, state: "warm" })]);
  });

  it("treats a ready device still referenced by a lease as leased (ready-but-leased edge case)", () => {
    const vm = parseStatus(
      {
        devices: [device("dev_1", "ready")],
        leases: [lease("dev_1", "agent-b", { grantedAt: 400 })],
      },
      { now: 1_000 },
    );
    expect(vm.devices).toEqual([
      expect.objectContaining({ agent: "agent-b", forMs: 600, state: "leased" }),
    ]);
  });

  it.each(["provisioning", "reclaiming"])("classifies %s as busy", (state) => {
    const vm = parseStatus(
      { devices: [device("dev_1", state, { createdAt: 500 })] },
      { now: 1_000 },
    );
    expect(vm.devices).toEqual([expect.objectContaining({ forMs: 500, state: "busy" })]);
  });

  it("classifies shutdown as shutdown", () => {
    const vm = parseStatus(
      { devices: [device("dev_1", "shutdown", { lastLeaseEndedAt: 600 })] },
      { now: 1_000 },
    );
    expect(vm.devices).toEqual([expect.objectContaining({ forMs: 400, state: "shutdown" })]);
  });

  it("never shows deleted devices", () => {
    const vm = parseStatus({ devices: [device("dev_1", "deleted")] }, { now: 1_000 });
    expect(vm.devices).toEqual([]);
  });

  it("falls back an unrecognized/renamed state to the quiet shutdown row instead of throwing", () => {
    const vm = parseStatus({ devices: [device("dev_1", "quantum-superposed")] }, { now: 1_000 });
    expect(vm.devices).toEqual([expect.objectContaining({ state: "shutdown" })]);
  });

  it("flags a device carrying a foreign-state or foreign-provenance marker", () => {
    const vm = parseStatus(
      {
        devices: [
          { ...device("dev_1", "ready"), foreignStateDetectedAt: 999 },
          { ...device("dev_2", "ready"), foreignProvenanceDetectedAt: 999 },
          device("dev_3", "ready"),
        ],
      },
      { now: 1_000 },
    );
    expect(vm.devices.map((d) => [d.id, d.flagged])).toEqual([
      ["dev_1", true],
      ["dev_2", true],
      ["dev_3", false],
    ]);
  });
});

describe("parseStatus: sort order and grouping", () => {
  it("sorts leased, warm, busy, shutdown, alphabetical by model within each group", () => {
    const vm = parseStatus(
      {
        devices: [
          device("shutdown-b", "shutdown", { spec: { model: "Zeta" } }),
          device("shutdown-a", "shutdown", { spec: { model: "Alpha" } }),
          device("warm-b", "ready", { spec: { model: "Zeta" } }),
          device("warm-a", "ready", { spec: { model: "Alpha" } }),
          device("busy-b", "provisioning", { spec: { model: "Zeta" } }),
          device("busy-a", "provisioning", { spec: { model: "Alpha" } }),
          device("leased-b", "leased", { spec: { model: "Zeta" } }),
          device("leased-a", "leased", { spec: { model: "Alpha" } }),
        ],
      },
      { now: 1_000 },
    );
    expect(vm.devices.map((d) => d.id)).toEqual([
      "leased-a",
      "leased-b",
      "warm-a",
      "warm-b",
      "busy-a",
      "busy-b",
      "shutdown-a",
      "shutdown-b",
    ]);
  });

  it("counts rows per group", () => {
    const vm = parseStatus(
      {
        devices: [
          device("d1", "leased"),
          device("d2", "ready"),
          device("d3", "provisioning"),
          device("d4", "shutdown"),
          device("d5", "shutdown"),
        ],
      },
      { now: 1_000 },
    );
    expect(vm.counts).toEqual({ busy: 1, leased: 1, shutdown: 2, warm: 1 });
  });
});

describe("parseStatus: defensive parsing", () => {
  it("never throws on a completely empty/garbage payload", () => {
    expect(() => parseStatus(undefined, { now: 1 })).not.toThrow();
    expect(() => parseStatus(null, { now: 1 })).not.toThrow();
    expect(() => parseStatus("nope", { now: 1 })).not.toThrow();
    expect(() => parseStatus([], { now: 1 })).not.toThrow();
    expect(() => parseStatus({}, { now: 1 })).not.toThrow();
  });

  it("defaults capacity buckets to zero when capacity is missing", () => {
    const vm = parseStatus({ devices: [] }, { now: 1 });
    expect(vm.capacity).toEqual({
      android: {
        limit: undefined,
        maxRunning: 0,
        overLimit: false,
        reserved: 0,
        running: 0,
        used: undefined,
        warm: 0,
      },
      global: {
        limit: undefined,
        maxRunning: 0,
        overLimit: false,
        reserved: 0,
        running: 0,
        used: undefined,
        warm: 0,
      },
      ios: {
        limit: undefined,
        maxRunning: 0,
        overLimit: false,
        reserved: 0,
        running: 0,
        used: undefined,
        warm: 0,
      },
    });
    expect(vm.overLimit).toBe(false);
  });

  it("defaults to an empty device list when devices is missing or malformed", () => {
    expect(parseStatus({ leases: [] }, { now: 1 }).devices).toEqual([]);
    expect(parseStatus({ devices: "not-an-array" }, { now: 1 }).devices).toEqual([]);
    expect(parseStatus({ devices: [null, 42, "x"] }, { now: 1 }).devices).toEqual([]);
  });

  it("falls back model/os to a placeholder when a device's spec is absent", () => {
    const vm = parseStatus(
      { devices: [{ createdAt: 0, id: "dev_1", state: "ready" }] },
      { now: 1 },
    );
    expect(vm.devices).toEqual([
      expect.objectContaining({ model: "?", osVersion: "?", platform: undefined }),
    ]);
  });

  it("never throws when a lease points at a device that does not exist", () => {
    expect(() =>
      parseStatus({ devices: [], leases: [lease("ghost-device", "agent-x")] }, { now: 1 }),
    ).not.toThrow();
    const vm = parseStatus({ devices: [], leases: [lease("ghost-device", "agent-x")] }, { now: 1 });
    expect(vm.devices).toEqual([]);
  });

  it("falls back health to starting on a missing/invalid value", () => {
    expect(parseStatus({}, { now: 1 }).health).toBe("starting");
    expect(parseStatus({ health: "on-fire" }, { now: 1 }).health).toBe("starting");
    expect(parseStatus({ health: "failed" }, { now: 1 }).health).toBe("failed");
  });

  it("falls back queueDepth to 0 on a missing/invalid value", () => {
    expect(parseStatus({}, { now: 1 }).queueDepth).toBe(0);
    expect(parseStatus({ queueDepth: "many" }, { now: 1 }).queueDepth).toBe(0);
    expect(parseStatus({ queueDepth: 3 }, { now: 1 }).queueDepth).toBe(3);
  });
});

describe("shutdown countdown derivation", () => {
  it("adds a shutdown countdown to a warm device when shutdownAfterMs is available", () => {
    const vm = parseStatus(
      { devices: [device("dev_1", "ready", { lastLeaseEndedAt: 900 })] },
      { now: 1_000, shutdownAfterMs: 10_000 },
    );
    expect(vm.devices).toEqual([expect.objectContaining({ forMs: 100, shutdownInMs: 9_900 })]);
  });

  it("clamps the countdown to 0 rather than going negative once the deadline has passed", () => {
    const vm = parseStatus(
      { devices: [device("dev_1", "ready", { lastLeaseEndedAt: 0 })] },
      { now: 1_000, shutdownAfterMs: 100 },
    );
    expect(vm.devices).toEqual([expect.objectContaining({ shutdownInMs: 0 })]);
  });

  it("omits the countdown when shutdownAfterMs was not available (config.get gave nothing)", () => {
    const vm = parseStatus({ devices: [device("dev_1", "ready")] }, { now: 1_000 });
    expect(vm.devices).toEqual([expect.objectContaining({ shutdownInMs: undefined })]);
  });

  it("never adds a countdown to a non-warm row", () => {
    const vm = parseStatus(
      { devices: [device("dev_1", "leased")], leases: [lease("dev_1", "agent-a")] },
      { now: 1_000, shutdownAfterMs: 10_000 },
    );
    expect(vm.devices).toEqual([expect.objectContaining({ shutdownInMs: undefined })]);
  });
});

describe("parseIdleShutdownAfterMs", () => {
  it("reads idle.shutdownAfterMs from a config.get response", () => {
    expect(parseIdleShutdownAfterMs({ idle: { shutdownAfterMs: 42_000 } })).toBe(42_000);
  });

  it.each([undefined, null, "nope", {}, { idle: {} }, { idle: { shutdownAfterMs: "soon" } }])(
    "returns undefined for %p",
    (raw) => {
      expect(parseIdleShutdownAfterMs(raw)).toBeUndefined();
    },
  );
});

describe("buildMeter", () => {
  it("splits the filled width proportionally to leased/warm/busy counts", () => {
    const meter = buildMeter(
      { busy: 1, leased: 2, warm: 1 },
      { maxRunning: 4, overLimit: false, running: 4 },
      20,
    );
    expect(meter.segments).toEqual([
      { kind: "leased", width: 10 },
      { kind: "warm", width: 5 },
      { kind: "busy", width: 5 },
    ]);
    expect(meter.fraction).toBe(1);
    expect(meter.overLimit).toBe(false);
  });

  it("segment widths always sum exactly to the requested width, despite rounding", () => {
    const meter = buildMeter(
      { busy: 1, leased: 1, warm: 1 },
      { maxRunning: 6, overLimit: false, running: 4 },
      20,
    );
    const sum = meter.segments.reduce((total, segment) => total + segment.width, 0);
    expect(sum).toBe(20);
  });

  it("never divides by zero when maxRunning is 0, and does not fill the bar", () => {
    const idle = buildMeter(
      { busy: 0, leased: 0, warm: 0 },
      { maxRunning: 0, overLimit: false, running: 0 },
      20,
    );
    expect(idle.fraction).toBe(0);
    expect(idle.segments).toEqual([{ kind: "empty", width: 20 }]);

    const stuck = buildMeter(
      { busy: 1, leased: 0, warm: 0 },
      { maxRunning: 0, overLimit: false, running: 1 },
      20,
    );
    expect(stuck.fraction).toBe(1);
    expect(Number.isFinite(stuck.fraction)).toBe(true);
  });

  it("flags overLimit when running exceeds maxRunning, even if the daemon didn't say so", () => {
    const meter = buildMeter(
      { busy: 0, leased: 5, warm: 0 },
      { maxRunning: 4, overLimit: false, running: 5 },
      20,
    );
    expect(meter.overLimit).toBe(true);
    expect(meter.fraction).toBe(1);
  });

  it("trusts the daemon's own overLimit flag too", () => {
    const meter = buildMeter(
      { busy: 0, leased: 1, warm: 0 },
      { maxRunning: 4, overLimit: true, running: 1 },
      20,
    );
    expect(meter.overLimit).toBe(true);
  });

  it("renders an all-empty bar when there is nothing running", () => {
    const meter = buildMeter(
      { busy: 0, leased: 0, warm: 0 },
      { maxRunning: 4, overLimit: false, running: 0 },
      20,
    );
    expect(meter.segments).toEqual([{ kind: "empty", width: 20 }]);
  });
});

describe("duration formatting", () => {
  it("formatDuration: precise M:SS below an hour, HhMMm at/above an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(8_000)).toBe("0:08");
    expect(formatDuration(252_000)).toBe("4:12");
    expect(formatDuration(63_000)).toBe("1:03");
    expect(formatDuration((2 * 3600 + 4 * 60) * 1000)).toBe("2h04m");
    expect(formatDuration(-5_000)).toBe("0:00");
  });

  it("formatCoarseDuration: bare Mm below an hour, HhMMm at/above an hour", () => {
    expect(formatCoarseDuration(41 * 60_000)).toBe("41m");
    expect(formatCoarseDuration((2 * 3600 + 4 * 60) * 1000)).toBe("2h04m");
    expect(formatCoarseDuration(0)).toBe("0m");
    expect(formatCoarseDuration(-1_000)).toBe("0m");
  });

  it("formatRelativeAge: compact Ns/Nm/Nh/Nd", () => {
    expect(formatRelativeAge(12_000)).toBe("12s");
    expect(formatRelativeAge(3 * 60_000)).toBe("3m");
    expect(formatRelativeAge(5 * 3_600_000)).toBe("5h");
    expect(formatRelativeAge(2 * 86_400_000)).toBe("2d");
    expect(formatRelativeAge(-1)).toBe("0s");
  });
});

describe("summarizeEvent", () => {
  const label = (id: string) => (id === "dev_1" ? "iPhone 17 Pro" : undefined);

  it("summarizes lease.granted with the resolved device label and age", () => {
    const summary = summarizeEvent(
      {
        event: "lease.granted",
        payload: { deviceId: "dev_1", requester: "agent-e2e-7" },
        timestamp: 988,
      },
      1_000,
      label,
    );
    expect(summary).toEqual({
      ageMs: 12,
      event: "lease.granted",
      summary: "agent-e2e-7 → iPhone 17 Pro",
    });
  });

  it("falls back to the raw device id when the label lookup misses", () => {
    const summary = summarizeEvent(
      { event: "device.shutdown", payload: { deviceId: "dev_unknown" }, timestamp: 1_000 },
      1_000,
      label,
    );
    expect(summary?.summary).toBe("dev_unknown");
  });

  it("returns undefined for a malformed envelope instead of throwing", () => {
    expect(summarizeEvent(undefined, 1_000, label)).toBeUndefined();
    expect(summarizeEvent({}, 1_000, label)).toBeUndefined();
    expect(summarizeEvent({ event: 42 }, 1_000, label)).toBeUndefined();
  });

  it("clamps age to 0 rather than going negative on clock skew", () => {
    const summary = summarizeEvent(
      { event: "daemon.started", payload: {}, timestamp: 5_000 },
      1_000,
      label,
    );
    expect(summary?.ageMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function device(
  id: string,
  state: string,
  overrides: {
    readonly createdAt?: number;
    readonly lastLeaseEndedAt?: number;
    readonly spec?: {
      readonly model?: string;
      readonly osVersion?: string;
      readonly platform?: string;
    };
  } = {},
): Record<string, unknown> {
  return {
    createdAt: overrides.createdAt ?? 0,
    id,
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios", ...overrides.spec },
    state,
    ...(overrides.lastLeaseEndedAt === undefined
      ? {}
      : { lastLeaseEndedAt: overrides.lastLeaseEndedAt }),
  };
}

function lease(
  deviceId: string,
  requesterId: string,
  overrides: { readonly grantedAt?: number } = {},
): Record<string, unknown> {
  return { deviceId, grantedAt: overrides.grantedAt ?? 0, id: `lse_${deviceId}`, requesterId };
}

describe("parseStatus: sort order", () => {
  it("orders models case-insensitively so capitalization does not jump the queue", () => {
    const now = 1_000_000;
    const vm = parseStatus(
      {
        devices: [
          {
            id: "d1",
            spec: { model: "Pixel 8", osVersion: "35", platform: "android" },
            state: "leased",
            createdAt: 0,
          },
          {
            id: "d2",
            spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
            state: "leased",
            createdAt: 0,
          },
        ],
        leases: [],
      },
      { now },
    );

    expect(vm.devices.map((device) => device.model)).toEqual(["iPhone 17 Pro", "Pixel 8"]);
  });
});

describe("meterLayout", () => {
  const capacity = (
    global: [number, number],
    ios: [number, number],
    android: [number, number],
  ): Capacity => {
    const usage = ([running, maxRunning]: [number, number]): CapacityUsage => ({
      limit: undefined,
      maxRunning,
      overLimit: false,
      reserved: 0,
      running,
      used: undefined,
      warm: 0,
    });
    return { android: usage(android), global: usage(global), ios: usage(ios) };
  };

  const renderedWidth = (width: number, value: Capacity): number => {
    const { barWidth, showPlatforms } = meterLayout(width, value, 20);
    const tail = showPlatforms
      ? `   ios ${value.ios.running}/${value.ios.maxRunning}` +
        `   android ${value.android.running}/${value.android.maxRunning}`
      : "";
    const core =
      2 + "Running ".length + 2 + `${value.global.running}/${value.global.maxRunning}`.length;
    return core + barWidth + tail.length;
  };

  it.each([40, 50, 60, 66, 72, 80, 120])(
    "never exceeds the terminal width at %d columns",
    (width) => {
      expect(renderedWidth(width, capacity([4, 6], [3, 4], [1, 2]))).toBeLessThanOrEqual(width);
    },
  );

  it.each([40, 60, 66, 72, 80, 120])(
    "never exceeds the terminal width at %d columns with two-digit capacities",
    (width) => {
      expect(renderedWidth(width, capacity([12, 16], [10, 12], [2, 4]))).toBeLessThanOrEqual(width);
    },
  );

  it("drops the per-platform tail before shrinking the bar", () => {
    const narrow = meterLayout(50, capacity([4, 6], [3, 4], [1, 2]), 20);

    expect(narrow.showPlatforms).toBe(false);
    expect(narrow.barWidth).toBe(20);
  });

  it("keeps the per-platform tail when there is room for it", () => {
    expect(meterLayout(80, capacity([4, 6], [3, 4], [1, 2]), 20).showPlatforms).toBe(true);
  });

  it("shrinks the bar rather than wrapping once the tail is already gone", () => {
    expect(meterLayout(30, capacity([4, 6], [3, 4], [1, 2]), 20).barWidth).toBe(15);
  });

  it("floors the bar at 6 columns instead of going negative", () => {
    expect(meterLayout(5, capacity([4, 6], [3, 4], [1, 2]), 20).barWidth).toBe(6);
  });

  it("accounts for wider capacity digits when deciding to show platforms", () => {
    const single = meterLayout(60, capacity([4, 6], [3, 4], [1, 2]), 20);
    const double = meterLayout(60, capacity([12, 16], [10, 12], [2, 4]), 20);

    expect(single.showPlatforms).toBe(true);
    expect(double.showPlatforms).toBe(false);
  });
});

describe("resolveWidth", () => {
  it("prefers a real TTY column count", () => {
    expect(resolveWidth(120, "60")).toBe(120);
  });

  it("falls back to COLUMNS on a pipe, matching what Ink lays out against", () => {
    expect(resolveWidth(undefined, "66")).toBe(66);
  });

  it("falls back to 80 when neither is usable", () => {
    expect(resolveWidth(undefined, undefined)).toBe(80);
    expect(resolveWidth(0, "not-a-number")).toBe(80);
    expect(resolveWidth(undefined, "-5")).toBe(80);
  });
});
