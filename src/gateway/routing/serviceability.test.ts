import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../test-support.js";
import type { WorkerView } from "../worker-registry.js";
import { assess } from "./serviceability.js";

type CatalogEntry = Parameters<typeof catalogFixture>[0][number];

const IOS: CatalogEntry = { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] };
const REQUEST = { model: "iPhone 17", osVersion: "26.0", platform: "ios" as const };

/** A worker that takes requests, with one catalog entry. */
function view(id: string, entry: CatalogEntry = IOS, overrides: Partial<WorkerView> = {}) {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([entry]).platforms,
    catalogReadAt: 1,
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: 1,
    leases: [],
    ...overrides,
  } satisfies WorkerView;
}

function rejectionOf(views: readonly WorkerView[], request: Parameters<typeof assess>[0]) {
  const verdict = assess(request, views);
  if (verdict.kind !== "reject") throw new Error(`expected a rejection, got ${verdict.kind}`);
  return verdict;
}

describe("assess", () => {
  it("row 1: with no worker that takes requests, says NO_CAPACITY for no-worker, whatever the catalogs hold", () => {
    const views = [
      view("wrk_drained", IOS, { drained: true }),
      view("wrk_away", IOS, { connection: "disconnected" }),
      view("wrk_pending", IOS, { catalogReadAt: undefined }),
    ];

    expect(rejectionOf(views, REQUEST)).toMatchObject({
      code: "NO_CAPACITY",
      message: "No worker in the fleet can currently serve this request",
      reason: "no-worker",
    });
    expect(rejectionOf([], REQUEST)).toMatchObject({ code: "NO_CAPACITY", reason: "no-worker" });
  });

  it("row 2: when a worker takes requests and no known worker has the platform, says NO_DRIVER with the platform", () => {
    const request = { model: "Pixel 8", platform: "android" as const };

    expect(rejectionOf([view("wrk_a")], request)).toMatchObject({
      code: "NO_DRIVER",
      details: { platform: "android" },
      message: "No driver registered for platform: android",
      reason: "unresolvable-spec",
    });
  });

  it("row 2: a platform only a worker that does not take requests has is still known, so the answer is NO_CAPACITY", () => {
    const android = { models: ["Pixel 8"], platform: "android" as const, runtimes: ["35"] };
    const views = [view("wrk_a"), view("wrk_drained", android, { drained: true })];

    expect(rejectionOf(views, { model: "Pixel 8", platform: "android" })).toMatchObject({
      code: "NO_CAPACITY",
      reason: "no-worker",
    });
  });

  it("row 3: when no known worker lists the model, says UNKNOWN_MODEL with the platform and the model as asked", () => {
    expect(rejectionOf([view("wrk_a")], { ...REQUEST, model: "iPhone 99" })).toMatchObject({
      code: "UNKNOWN_MODEL",
      details: { model: "iPhone 99", platform: "ios" },
      message: "Unknown ios model: iPhone 99",
      reason: "unresolvable-spec",
    });
  });

  it("row 3: lists the model by an alias and in any letter case", () => {
    const aliased = view("wrk_a", { ...IOS, modelAliases: { "iPhone 17": ["iphone-17"] } });

    expect(assess({ ...REQUEST, model: "IPHONE-17" }, [aliased]).kind).toBe("route-or-wait");
  });

  it("row 4: when no known worker has the runtime, says RUNTIME_MISSING, not downloadable, naming the runtime", () => {
    expect(rejectionOf([view("wrk_a")], { ...REQUEST, osVersion: "99.0" })).toMatchObject({
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion: "99.0", platform: "ios" },
      message: "Runtime missing for ios 99.0",
      reason: "unresolvable-spec",
    });
  });

  it("row 4: names osVersion default when the request named no runtime", () => {
    const unpaired = view("wrk_a", { ...IOS, modelRuntimes: { "iPhone 17": [] } });
    const { osVersion: _named, ...unnamed } = REQUEST;

    expect(rejectionOf([unpaired], unnamed)).toMatchObject({
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion: "default", platform: "ios" },
    });
  });

  it("row 4: says RUNTIME_MISSING when one worker has the model and another the runtime, and neither pairs them", () => {
    const withModel = view("wrk_a", { ...IOS, modelRuntimes: { "iPhone 17": ["18.0"] } });
    const withRuntime = view("wrk_b", {
      models: ["iPhone 16"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    expect(rejectionOf([withModel, withRuntime], REQUEST).code).toBe("RUNTIME_MISSING");
  });

  it("row 5: when a known worker can serve it and none that takes requests can, says NO_CAPACITY for no-worker", () => {
    const other = view("wrk_a", { models: ["iPhone 16"], platform: "ios", runtimes: ["26.0"] });
    const away = view("wrk_b", IOS, { connection: "disconnected" });

    expect(rejectionOf([other, away], REQUEST)).toMatchObject({
      code: "NO_CAPACITY",
      reason: "no-worker",
    });
    expect(rejectionOf([other, view("wrk_c", IOS, { drained: true })], REQUEST).code).toBe(
      "NO_CAPACITY",
    );
  });

  it("row 6: a worker that takes requests and can serve it makes the request route-or-wait, busy or not", () => {
    const capacity = statusFixture().capacity;
    const busy = view("wrk_a", IOS, {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } },
    });

    expect(assess(REQUEST, [busy]).kind).toBe("route-or-wait");
  });

  it("says NO_CAPACITY, never UNKNOWN_MODEL, when the only worker connected for the first time and its catalog has not arrived", () => {
    const first = view("wrk_a", IOS, {
      catalog: [],
      catalogReadAt: undefined,
    });

    expect(rejectionOf([first], REQUEST)).toMatchObject({
      code: "NO_CAPACITY",
      reason: "no-worker",
    });
  });

  it("says NO_DRIVER when the only worker that takes requests read an empty catalog", () => {
    const empty = view("wrk_a", IOS, { catalog: [] });

    expect(rejectionOf([empty], REQUEST).code).toBe("NO_DRIVER");
  });

  it("knows a reconnecting worker from its last catalog while the new one is on the way", () => {
    const reconnecting = view("wrk_a", IOS, { catalogReadAt: undefined });
    const other = view("wrk_b", { models: ["iPhone 16"], platform: "ios", runtimes: ["26.0"] });

    expect(rejectionOf([reconnecting, other], REQUEST)).toMatchObject({
      code: "NO_CAPACITY",
      reason: "no-worker",
    });
  });

  it("does not know an incompatible worker, whatever catalog it once had", () => {
    const incompatible = view("wrk_a", IOS, { connection: "incompatible" });
    const other = view("wrk_b", { models: ["iPhone 16"], platform: "ios", runtimes: ["26.0"] });

    expect(rejectionOf([incompatible, other], REQUEST).code).toBe("UNKNOWN_MODEL");
  });

  describe("a class request", () => {
    const PHONE: CatalogEntry = {
      modelClasses: { "iPhone 17": "phone" } as const,
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    };
    const request = { class: "phone" as const, platform: "ios" as const };

    it("row 3: when no known worker lists a model of the class, says UNKNOWN_MODEL with the class in its details", () => {
      expect(rejectionOf([view("wrk_a", PHONE)], { ...request, class: "watch" })).toMatchObject({
        code: "UNKNOWN_MODEL",
        details: { class: "watch", platform: "ios" },
        reason: "unresolvable-spec",
      });
      const rejection = rejectionOf([view("wrk_a", PHONE)], { ...request, class: "watch" });
      expect(rejection.details).not.toHaveProperty("model");
      expect(rejection.message).toBe(
        "No ios model of class watch is listed by any worker in the fleet; name one in ios.defaultModels.watch on a worker",
      );
    });

    it("row 3: treats a request naming neither model nor class as phone", () => {
      const tablets: CatalogEntry = {
        modelClasses: { "iPad Pro": "tablet" } as const,
        models: ["iPad Pro"],
        platform: "ios",
        runtimes: ["26.0"],
      };

      expect(rejectionOf([view("wrk_a", tablets)], { platform: "ios" })).toMatchObject({
        code: "UNKNOWN_MODEL",
        details: { class: "phone", platform: "ios" },
      });
    });

    it("row 4: when models of the class pair with no runtime in the range, says RUNTIME_MISSING with the range as typed", () => {
      expect(rejectionOf([view("wrk_a", PHONE)], { ...request, osVersion: "<=17" })).toMatchObject({
        code: "RUNTIME_MISSING",
        details: { downloadable: false, osVersion: "<=17", platform: "ios" },
        message: "Runtime missing for ios <=17",
      });
    });

    it("row 6: routes a class request a worker can serve", () => {
      expect(assess({ ...request, osVersion: ">=18" }, [view("wrk_a", PHONE)]).kind).toBe(
        "route-or-wait",
      );
    });
  });
});
