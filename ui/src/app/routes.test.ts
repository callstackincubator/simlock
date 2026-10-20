import { describe, expect, it } from "vitest";

import { ROUTES, routeFor } from "./routes";

describe("the console's routes", () => {
  it("opens the overview at the root and each section at its path and the pages under it", () => {
    expect(routeFor("/")?.label).toBe("Overview");
    expect(routeFor("/fleet")?.label).toBe("Fleet");
    expect(routeFor("/fleet/wrk_1")?.label).toBe("Fleet");
    expect(routeFor("/activity/e1")?.label).toBe("Activity");
    expect(routeFor("/usage")?.label).toBe("Usage");
  });

  it("has no route for a path no section owns, one that only shares a prefix included", () => {
    expect(routeFor("/fleetx")).toBeUndefined();
    expect(routeFor("/nope")).toBeUndefined();
  });

  it("lists the sections in the sidebar's order, the overview first", () => {
    expect(ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/inbox",
      "/fleet",
      "/leases",
      "/queue",
      "/activity",
      "/usage",
    ]);
  });
});
