import { describe, expect, it } from "vitest";

import { staleKeys } from "./stale-keys";

describe("a memory.pressure-changed event", () => {
  it("marks the console's workers stale, and an unrelated event does not", () => {
    expect(staleKeys("memory.pressure-changed", {})).toContainEqual(["workers"]);
    expect(staleKeys("something.unrelated", {})).toEqual([]);
  });
});
