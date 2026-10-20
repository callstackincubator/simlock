import { describe, expect, it } from "vitest";

import { itemIdFrom, itemPath } from "./paths";

describe("an item's page path", () => {
  it("carries any id, a slash or a space included, and reads it back whole", () => {
    for (const id of ["wrk_1", "wrk 1/dev_2/quarantined", "a%b"]) {
      expect(itemIdFrom("/attention", itemPath("/attention", id)), id).toBe(id);
    }
  });

  it("names no item on the section's own page or on another section's", () => {
    expect(itemIdFrom("/events", "/events")).toBeUndefined();
    expect(itemIdFrom("/events", "/events/")).toBeUndefined();
    expect(itemIdFrom("/events", "/eventsx/1")).toBeUndefined();
    expect(itemIdFrom("/events", "/leases/1")).toBeUndefined();
  });

  it("keeps a malformed escape as it was typed", () => {
    expect(itemIdFrom("/events", "/events/%E0%A4%A")).toBe("%E0%A4%A");
  });
});
