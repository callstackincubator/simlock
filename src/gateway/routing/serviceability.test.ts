import { describe, expect, it } from "vitest";

import { noPhysicalMatch } from "../../core/index.js";
import { catalogFixture, physicalDeviceFixture, statusFixture } from "../test-support.js";
import type { WorkerView } from "../worker-registry.js";
import { assess } from "./serviceability.js";

type CatalogEntry = Parameters<typeof catalogFixture>[0][number];

const IOS: CatalogEntry = { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] };
const REQUEST = {
  physical: false,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

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

  it("judges a request on the other workers when one has no catalog at all", () => {
    const { catalog: _catalog, ...unread } = view("wrk_a", IOS, { catalogReadAt: undefined });

    expect(assess(REQUEST, [unread, view("wrk_b")])).toEqual({ kind: "route-or-wait" });
    expect(rejectionOf([unread, view("wrk_b")], { ...REQUEST, model: "iPhone 99" }).code).toBe(
      "UNKNOWN_MODEL",
    );
  });

  it("makes a request only a starting worker can serve wait, though another worker takes requests but lists no such model", () => {
    const { capacity: _capacity, catalogReadAt: _readAt, ...restarting } = view("wrk_a");
    const other = view("wrk_b", { models: ["iPad Pro"], platform: "ios", runtimes: ["26.0"] });

    expect(assess(REQUEST, [{ ...restarting, health: "starting" }, other])).toEqual({
      kind: "route-or-wait",
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

describe("assess for a physical request", () => {
  const PHYSICAL = { physical: true as const, platform: "ios" as const };
  const withDevices = (id: string, devices: WorkerView["devices"], overrides = {}) =>
    view(id, IOS, { devices, ...overrides });

  it.each(["ready", "leased", "reclaiming", "absent", "quarantined"] as const)(
    "routes or waits a physical request whose only enrolled match is %s",
    (state) => {
      const views = [withDevices("wrk_a", [physicalDeviceFixture("dev_p", state)])];

      expect(assess(PHYSICAL, views)).toStrictEqual({ kind: "route-or-wait" });
    },
  );

  it("routes or waits a physical request whose only enrolled match is ready with presence not present", () => {
    const presence = { present: false, reason: "not-present" } as const;
    const views = [withDevices("wrk_a", [physicalDeviceFixture("dev_p", "ready", { presence })])];

    expect(assess(PHYSICAL, views)).toStrictEqual({ kind: "route-or-wait" });
  });

  it("fails a physical request with UNKNOWN_MODEL when its only match is deleted, with the message and details noPhysicalMatch gives", () => {
    const views = [withDevices("wrk_a", [physicalDeviceFixture("dev_p", "deleted")])];
    const named = {
      ...PHYSICAL,
      class: "phone" as const,
      model: "iPhone 15 Pro",
      osVersion: ">=18 <19",
    };

    for (const request of [named, PHYSICAL]) {
      expect(rejectionOf(views, request)).toEqual({
        ...noPhysicalMatch(request),
        code: "UNKNOWN_MODEL",
        kind: "reject",
        reason: "unresolvable-spec",
      });
    }
    expect(rejectionOf(views, PHYSICAL).details).toStrictEqual({ platform: "ios" });
    expect(rejectionOf(views, named).details).toStrictEqual({
      class: "phone",
      model: "iPhone 15 Pro",
      osVersion: ">=18 <19",
      platform: "ios",
    });
  });

  it("fails a physical request with UNKNOWN_MODEL when no listed device matches its model, class or OS", () => {
    const views = [withDevices("wrk_a", [physicalDeviceFixture("dev_p", "ready")])];

    expect(assess({ ...PHYSICAL, model: "iPhone 15 pro" }, views).kind).toBe("route-or-wait");
    for (const request of [
      { ...PHYSICAL, model: "iPhone 99" },
      { ...PHYSICAL, class: "tablet" as const },
      { ...PHYSICAL, osVersion: ">=17 <18" },
    ]) {
      expect(rejectionOf(views, request).code).toBe("UNKNOWN_MODEL");
    }
  });

  it("routes or waits a physical request whose worker's catalog lists no model or runtime for it but has an enrolled match", () => {
    const catalogOnly: CatalogEntry = {
      models: ["iPhone 16"],
      platform: "ios",
      runtimes: ["26.0"],
    };
    const worker = view("wrk_a", catalogOnly, {
      devices: [physicalDeviceFixture("dev_p", "ready")],
    });

    expect(assess({ ...PHYSICAL, model: "iPhone 15 Pro", osVersion: "18.4" }, [worker])).toEqual({
      kind: "route-or-wait",
    });
  });

  it("answers a physical request NO_DRIVER when no known worker's catalog has the platform", () => {
    const worker = withDevices("wrk_a", [
      physicalDeviceFixture("dev_p", "ready", {
        model: "Pixel 9",
        osVersion: "34",
        platform: "android",
      }),
    ]);

    expect(rejectionOf([worker], { ...PHYSICAL, platform: "android" })).toMatchObject({
      code: "NO_DRIVER",
      details: { platform: "android" },
    });
  });

  it("fails a physical request with UNKNOWN_MODEL when only an incompatible worker lists a match, and with NO_CAPACITY no-worker when only a disconnected worker does", () => {
    const devices = [physicalDeviceFixture("dev_p", "ready")];
    const other = view("wrk_b");

    expect(
      rejectionOf([withDevices("wrk_a", devices, { connection: "incompatible" }), other], PHYSICAL),
    ).toMatchObject({ code: "UNKNOWN_MODEL", reason: "unresolvable-spec" });
    expect(
      rejectionOf([withDevices("wrk_a", devices, { connection: "disconnected" }), other], PHYSICAL),
    ).toMatchObject({ code: "NO_CAPACITY", reason: "no-worker" });
  });

  it("fails a physical request with NO_CAPACITY no-worker when its only enrolled match is on a drained worker", () => {
    const devices = [physicalDeviceFixture("dev_p", "ready")];

    expect(
      rejectionOf([withDevices("wrk_a", devices, { drained: true }), view("wrk_b")], PHYSICAL),
    ).toMatchObject({ code: "NO_CAPACITY", reason: "no-worker" });
  });

  it("matches an iPad entry of class tablet to --class tablet, and not to a physical request naming neither class nor model", () => {
    const views = [
      withDevices("wrk_a", [
        physicalDeviceFixture("dev_ipad", "ready", { class: "tablet", model: "iPad Pro 13-inch" }),
      ]),
    ];

    expect(assess({ ...PHYSICAL, class: "tablet" }, views).kind).toBe("route-or-wait");
    expect(rejectionOf(views, PHYSICAL).code).toBe("UNKNOWN_MODEL");
  });
});

describe("assess with requires", () => {
  const AGENT_DEVICE = { ...REQUEST, requires: ["agent-device"] };
  const available = [{ name: "agent-device", state: "available" }] as const;
  const off = [{ name: "agent-device", state: "off" }] as const;
  const message = "No worker connected to this gateway can serve agent-device for this request";

  it("routes or waits when a worker that can serve the request lists every required name as available", () => {
    const views = [
      view("wrk_a", IOS, { capabilities: [...off] }),
      view("wrk_b", IOS, { capabilities: [...available] }),
    ];

    expect(assess(AGENT_DEVICE, views).kind).toBe("route-or-wait");
    expect(
      assess({ ...AGENT_DEVICE, requires: [] }, [view("wrk_a", IOS, { capabilities: [...off] })])
        .kind,
    ).toBe("route-or-wait");
  });

  it("answers CAPABILITY_MISSING, reason unresolvable-spec, naming the required names in the order requested, when no worker that can serve the request has them available", () => {
    const views = [view("wrk_a", IOS, { capabilities: [...off] })];

    expect(rejectionOf(views, AGENT_DEVICE)).toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      message,
      reason: "unresolvable-spec",
    });
    expect(
      rejectionOf(views, { ...AGENT_DEVICE, requires: ["agent-device", "x-other"] }),
    ).toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device", "x-other"] },
      message: expect.stringContaining("agent-device, x-other"),
    });
  });

  it("answers CAPABILITY_MISSING when only a worker without the capability lists the model", () => {
    const views = [
      view(
        "wrk_a",
        { models: ["iPhone 16"], platform: "ios", runtimes: ["26.0"] },
        { capabilities: [...available] },
      ),
      view("wrk_b", IOS, { capabilities: [...off] }),
    ];

    expect(rejectionOf(views, AGENT_DEVICE)).toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("keeps the first table's rejection when it rejects: UNKNOWN_MODEL and NO_CAPACITY stand", () => {
    const unknown = { ...AGENT_DEVICE, model: "iPhone 99" };

    expect(rejectionOf([view("wrk_a", IOS, { capabilities: [...off] })], unknown)).toMatchObject({
      code: "UNKNOWN_MODEL",
    });
    expect(rejectionOf([], AGENT_DEVICE)).toMatchObject({
      code: "NO_CAPACITY",
      reason: "no-worker",
    });
  });

  it("answers CAPABILITY_MISSING for a request waiting only on a capable worker once that worker's view is starting, because a starting view has no capability list", () => {
    const running = view("wrk_a", IOS, { capabilities: [...available], health: "running" });
    const { capabilities: _dropped, ...restarted } = { ...running, health: "starting" as const };

    expect(assess(AGENT_DEVICE, [running]).kind).toBe("route-or-wait");
    expect(rejectionOf([restarted as WorkerView], AGENT_DEVICE)).toMatchObject({
      code: "CAPABILITY_MISSING",
      reason: "unresolvable-spec",
    });
  });
});
