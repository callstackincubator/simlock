import { describe, expect, it } from "vitest";

import { VIEWS, viewFor } from "./index";

describe("viewFor", () => {
  it("finds each view by its path, and the first view at /", () => {
    expect(VIEWS.map((view) => view.label)).toEqual([
      "Workers",
      "Leases",
      "Waiting",
      "Attention",
      "Events",
    ]);
    for (const view of VIEWS) expect(viewFor(view.path)).toBe(view);
    expect(viewFor("/leases/lease_1")?.label).toBe("Leases");
    expect(viewFor("/")).toBe(VIEWS[0]);
  });

  it("finds no view for a path the console does not have", () => {
    expect(viewFor("/no-such-page")).toBeUndefined();
    expect(viewFor("/workersx")).toBeUndefined();
  });
});
