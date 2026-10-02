import { describe, expect, it } from "vitest";

import { catalogFixture, deviceFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { warmHit } from "./warm-hit.js";

describe("warm-hit", () => {
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
