import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "./index.js";

describe("FakeSystemStats", () => {
  it("returns its configured system capacity values", () => {
    const stats = new FakeSystemStats({
      cpuCount: 12,
      freeRamBytes: 16_000,
      totalRamBytes: 32_000,
    });

    expect(stats.cpuCount()).toBe(12);
    expect(stats.totalRamBytes()).toBe(32_000);
    expect(stats.freeRamBytes()).toBe(16_000);
  });
});
