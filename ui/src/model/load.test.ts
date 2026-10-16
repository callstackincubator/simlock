import { describe, expect, it } from "vitest";

import { formatBusyPercent, formatBytes, formatCores, loadGauges } from "./load";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe("the load figures", () => {
  it("formats bytes, busy % and cores as the CLI's Load line does, including 0, 1023.6 MiB, 0.5 cores, 1 core and 0.001 cores", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(300 * MIB)).toBe("300 MiB");
    expect(formatBytes(1023.6 * MIB)).toBe("1.0 GiB");
    expect(formatBytes(9.8 * GIB)).toBe("9.8 GiB");
    expect(formatBusyPercent(33.5)).toBe("34%");
    expect(formatBusyPercent(33.4)).toBe("33%");
    expect(formatCores(10)).toBe("10 cores");
    expect(formatCores(0.5)).toBe("0.5 cores");
    expect(formatCores(1)).toBe("1 core");
    expect(formatCores(0.01)).toBe("0.01 cores");
    expect(formatCores(0.001)).toBe("<0.01 cores");
  });
});

const FULL = {
  cpu: { busyPercent: 34, cores: 10, limited: false },
  disk: { freeBytes: 112.4 * GIB, totalBytes: 494.4 * GIB },
  memory: {
    availableBytes: 9.8 * GIB,
    limited: false,
    swapUsedBytes: 0,
    totalBytes: 32 * GIB,
  },
  readAt: 0,
};

describe("how full each figure is", () => {
  it("answers each figure's fullness as a whole percent", () => {
    expect(loadGauges(FULL)).toEqual({ cpu: 34, disk: 77, memory: 69 });
  });

  it("rounds a gauge's percent the way the figure above it does", () => {
    const shown = (percent: number) => Number(formatBusyPercent(percent).replace("%", ""));

    // why: the last is the float just under a half, where the two roundings part company — the only
    // input that tells this pair of roundings apart, so the title holds for every case here.
    for (const busyPercent of [34.4, 34.5, 0.5, 99.5, 0.49999999999999994]) {
      const cpu = { busyPercent, cores: 10, limited: false };

      expect(loadGauges({ ...FULL, cpu }).cpu).toBe(shown(busyPercent));
    }
  });

  it("fills the bar for a figure at or over its own total and empties it for one with nothing used", () => {
    const full = loadGauges({
      ...FULL,
      cpu: { busyPercent: 100, cores: 10, limited: false },
      disk: { freeBytes: 0, totalBytes: 100 * GIB },
      memory: { ...FULL.memory, availableBytes: 0 },
    });
    const over = loadGauges({
      cpu: { busyPercent: 137, cores: 10, limited: false },
      disk: { freeBytes: -20 * GIB, totalBytes: 100 * GIB },
      memory: { ...FULL.memory, availableBytes: -5 * GIB },
      readAt: 0,
    });
    const empty = loadGauges({
      ...FULL,
      cpu: { busyPercent: -4, cores: 10, limited: false },
      disk: { freeBytes: 100 * GIB, totalBytes: 100 * GIB },
      memory: { ...FULL.memory, availableBytes: 34 * GIB, totalBytes: 32 * GIB },
    });

    expect(full).toEqual({ cpu: 100, disk: 100, memory: 100 });
    expect(over).toEqual({ cpu: 100, disk: 100, memory: 100 });
    expect(empty).toEqual({ cpu: 0, disk: 0, memory: 0 });
  });

  it("answers nothing for a figure the reading gives no denominator for", () => {
    const { cpu: _cpu, ...noCpu } = FULL;
    const { memory: _memory, ...noMemory } = FULL;
    const { disk: _disk, ...noDisk } = FULL;
    const zeroTotals = {
      ...FULL,
      disk: { freeBytes: 12 * GIB, totalBytes: 0 },
      memory: { ...FULL.memory, totalBytes: 0 },
    };

    expect(loadGauges(noCpu)).toEqual({ disk: 77, memory: 69 });
    expect(loadGauges(noMemory)).toEqual({ cpu: 34, disk: 77 });
    expect(loadGauges(noDisk)).toEqual({ cpu: 34, memory: 69 });
    expect(loadGauges(zeroTotals)).toEqual({ cpu: 34 });
    expect(loadGauges({ readAt: 0 })).toEqual({});
  });
});
