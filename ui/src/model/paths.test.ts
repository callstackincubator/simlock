import { describe, expect, it } from "vitest";

import { itemIdFrom, itemPath } from "./paths";

describe("an item's page path", () => {
  it("carries any id, a slash or a space included, and reads it back whole", () => {
    for (const id of ["wrk_1", "wrk 1/dev_2/quarantined", "a%b"]) {
      expect(itemIdFrom("/attention", itemPath("/attention", id)), id).toBe(id);
    }
  });

  it("round-trips an id with a slash for /fleet, /queue and /activity", () => {
    for (const section of ["/fleet", "/queue", "/activity"] as const) {
      expect(itemPath(section, "a/b c"), section).toBe(`${section}/a%2Fb%20c`);
      expect(itemIdFrom(section, itemPath(section, "a/b c")), section).toBe("a/b c");
    }
  });

  it("names no item on the section's own page or on another section's", () => {
    expect(itemIdFrom("/activity", "/activity")).toBeUndefined();
    expect(itemIdFrom("/activity", "/activity/")).toBeUndefined();
    expect(itemIdFrom("/activity", "/activityx/1")).toBeUndefined();
    expect(itemIdFrom("/activity", "/leases/1")).toBeUndefined();
  });

  it("keeps a malformed escape as it was typed", () => {
    expect(itemIdFrom("/activity", "/activity/%E0%A4%A")).toBe("%E0%A4%A");
  });
});
