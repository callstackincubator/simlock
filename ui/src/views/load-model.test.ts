import { describe, expect, it } from "vitest";

import { formatBusyPercent, formatBytes, formatCores, loadSummary } from "./load-model";

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

describe("the card summary", () => {
  it("lists CPU, memory and disk as the table shows, with (limit) on a limited part, including memory under 1 GiB", () => {
    expect(loadSummary(FULL)).toBe("CPU 34% · memory 9.8 of 32.0 GiB · disk 112.4 GiB free");
    expect(
      loadSummary({
        ...FULL,
        cpu: { busyPercent: 61, cores: 2, limited: true },
        disk: { freeBytes: 40.2 * GIB, totalBytes: 100 * GIB },
        memory: { ...FULL.memory, availableBytes: 3.1 * GIB, limited: true, totalBytes: 8 * GIB },
      }),
    ).toBe("CPU 61% (limit) · memory 3.1 of 8.0 GiB (limit) · disk 40.2 GiB free");
    expect(
      loadSummary({
        ...FULL,
        memory: { ...FULL.memory, availableBytes: 300 * MIB, totalBytes: 8 * GIB },
      }),
    ).toContain("memory 300 MiB of 8.0 GiB");
  });

  it("says CPU unavailable, memory unavailable or disk unavailable for an absent part", () => {
    const { cpu: _cpu, ...noCpu } = FULL;
    const { memory: _memory, ...noMemory } = FULL;
    const { disk: _disk, ...noDisk } = FULL;

    expect(loadSummary(noCpu)).toBe(
      "CPU unavailable · memory 9.8 of 32.0 GiB · disk 112.4 GiB free",
    );
    expect(loadSummary(noMemory)).toBe("CPU 34% · memory unavailable · disk 112.4 GiB free");
    expect(loadSummary(noDisk)).toBe("CPU 34% · memory 9.8 of 32.0 GiB · disk unavailable");
  });
});
