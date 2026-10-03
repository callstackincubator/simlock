import { describe, expect, it } from "vitest";

import { catalogFixture, deviceFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { warmHit } from "./warm-hit.js";

describe("warm-hit", () => {
  it("does not count a leased device as warm, only a ready one", () => {
    const view = (state: "ready" | "leased"): WorkerView => ({
      capacity: statusFixture().capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      connection: "connected",
      devices: [deviceFixture("dev_1", state)],
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const request = {
      allowDownload: false,
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios" as const,
    };

    expect(warmHit.score(view("leased"), request)).toBe(0);
    expect(warmHit.score(view("ready"), request)).toBe(1);
  });

  it("counts a ready device as warm only on the request's platform and, when it names one, its OS version", () => {
    const ready = deviceFixture("dev_1", "ready");
    const view = (spec: Partial<WorkerView["devices"][number]["spec"]>): WorkerView => ({
      capacity: statusFixture().capacity,
      catalog: catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0", "18.0"] },
      ]).platforms,
      connection: "connected",
      devices: [{ ...ready, spec: { ...ready.spec, ...spec } }],
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const request = { allowDownload: false, model: "iPhone 17", platform: "ios" as const };

    expect(warmHit.score(view({ platform: "android" }), request)).toBe(0);
    expect(warmHit.score(view({ osVersion: "18.0" }), { ...request, osVersion: "26.0" })).toBe(0);
    expect(warmHit.score(view({ osVersion: "18.0" }), request)).toBe(1);
    expect(warmHit.score(view({}), { ...request, osVersion: "26.0" })).toBe(1);
  });

  it("counts a ready device as warm when the request names its model by an alias in another letter case", () => {
    const view: WorkerView = {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([
        {
          modelAliases: { "iPhone 17": ["iphone-17"] },
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
        },
      ]).platforms,
      connection: "connected",
      devices: [deviceFixture("dev_1", "ready")],
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    };
    const request = { allowDownload: false, osVersion: "26.0", platform: "ios" as const };

    expect(warmHit.score(view, { ...request, model: "IPHONE-17" })).toBe(1);
    expect(warmHit.score(view, { ...request, model: "iphone 17" })).toBe(1);
    expect(warmHit.score(view, { ...request, model: "iPhone 16" })).toBe(0);
  });

  it("counts a ready device as warm only when its image tag is the request's, or both have none", () => {
    const untagged = deviceFixture("dev_untagged", "ready");
    const tagged = { ...untagged, id: "dev_tagged", spec: { ...untagged.spec, imageTag: "x" } };
    const view = (devices: WorkerView["devices"]): WorkerView => ({
      capacity: statusFixture().capacity,
      catalog: catalogFixture([
        {
          images: [
            { abi: "arm64-v8a", runtime: "26.0", tag: "x" },
            { abi: "arm64-v8a", runtime: "26.0", tag: "y" },
          ],
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
        },
      ]).platforms,
      connection: "connected",
      devices,
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const request = {
      allowDownload: false,
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios" as const,
    };

    expect(warmHit.score(view([untagged]), { ...request, imageTag: "x" })).toBe(0);
    expect(warmHit.score(view([tagged]), { ...request, imageTag: "y" })).toBe(0);
    expect(warmHit.score(view([tagged]), request)).toBe(0);
    expect(warmHit.score(view([tagged]), { ...request, imageTag: "x" })).toBe(1);
    expect(warmHit.score(view([untagged]), request)).toBe(1);
  });
});
