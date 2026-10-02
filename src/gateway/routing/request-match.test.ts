import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../test-support.js";
import type { WorkerView } from "../worker-registry.js";
import { matchRequest } from "./request-match.js";

function worker(entry: Parameters<typeof catalogFixture>[0][number]): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([entry]).platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
  };
}

const PIXELS = {
  modelAliases: { "Pixel 7": ["pixel_7"], "Pixel 7 Legacy": ["pixel 7"] },
  platform: "android" as const,
  runtimes: ["35"],
};

describe("matchRequest", () => {
  it("matches a model name in another letter case and returns the worker's own name", () => {
    const view = worker({ models: ["iPhone 16 Pro"], platform: "ios", runtimes: ["26.0"] });

    expect(
      matchRequest(view, { allowDownload: false, model: "iphone 16 PRO", platform: "ios" }),
    ).toBe("iPhone 16 Pro");
  });

  it("matches a name the catalog lists as an alias, in any letter case", () => {
    const view = worker({ ...PIXELS, models: ["Pixel 7"] });

    expect(
      matchRequest(view, { allowDownload: false, model: "PIXEL_7", platform: "android" }),
    ).toBe("Pixel 7");
    expect(
      matchRequest(view, { allowDownload: false, model: "pixel_8", platform: "android" }),
    ).toBeUndefined();
  });

  it("when two models answer to a name, the first in models wins", () => {
    // "pixel 7" is the name of one model and an alias of the other.
    const request = { allowDownload: false, model: "pixel 7", platform: "android" as const };

    expect(
      matchRequest(worker({ ...PIXELS, models: ["Pixel 7", "Pixel 7 Legacy"] }), request),
    ).toBe("Pixel 7");
    expect(
      matchRequest(worker({ ...PIXELS, models: ["Pixel 7 Legacy", "Pixel 7"] }), request),
    ).toBe("Pixel 7 Legacy");
  });

  it("rejects a named runtime the catalog lists but does not pair with the model", () => {
    const view = worker({
      modelRuntimes: { "iPhone 17": ["18.0"] },
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["18.0", "26.0"],
    });
    const request = { allowDownload: false, model: "iPhone 17", platform: "ios" as const };

    expect(matchRequest(view, { ...request, osVersion: "26.0" })).toBeUndefined();
    expect(matchRequest(view, { ...request, osVersion: "18.0" })).toBe("iPhone 17");
  });

  it("with no runtime named, needs the model to pair with at least one", () => {
    const request = { allowDownload: false, model: "iPhone 17", platform: "ios" as const };
    const unpaired = worker({
      modelRuntimes: { "iPhone 17": [] },
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });
    const paired = worker({ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] });

    expect(matchRequest(unpaired, request)).toBeUndefined();
    expect(matchRequest(paired, request)).toBe("iPhone 17");
  });

  it("does not match on another platform's catalog", () => {
    const view = worker({ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] });

    expect(
      matchRequest(view, { allowDownload: false, model: "iPhone 17", platform: "android" }),
    ).toBeUndefined();
  });

  it("reads no inherited key as a pairing or an alias", () => {
    const view = worker({
      modelAliases: {},
      modelRuntimes: {},
      models: ["constructor"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    // No pairing: `modelRuntimes.constructor` is inherited, not a list of runtimes.
    expect(
      matchRequest(view, { allowDownload: false, model: "constructor", platform: "ios" }),
    ).toBeUndefined();
    // No alias: `modelAliases.constructor` is inherited, so asking for another name reads no
    // alias list for the model and moves on to the next one.
    const withNext = worker({
      modelAliases: {},
      models: ["constructor", "iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });
    expect(
      matchRequest(withNext, { allowDownload: false, model: "iPhone 17", platform: "ios" }),
    ).toBe("iPhone 17");
  });

  describe("with an image tag", () => {
    const TAGGED = {
      images: [
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis_playstore" },
      ],
      models: ["Pixel 8"],
      platform: "android" as const,
      runtimes: ["34", "35"],
    };
    const tagged = {
      allowDownload: false,
      imageTag: "google_apis_playstore",
      model: "Pixel 8",
      platform: "android" as const,
    };

    it("matches a named runtime that has an image of the tag", () => {
      expect(matchRequest(worker(TAGGED), { ...tagged, osVersion: "35" })).toBe("Pixel 8");
    });

    it("rejects a named runtime that has images of other tags only", () => {
      expect(matchRequest(worker(TAGGED), { ...tagged, osVersion: "34" })).toBeUndefined();
    });

    it("with no runtime named, needs one runtime with an image of the tag", () => {
      expect(matchRequest(worker(TAGGED), tagged)).toBe("Pixel 8");
      expect(matchRequest(worker(TAGGED), { ...tagged, imageTag: "default" })).toBeUndefined();
    });

    it("rejects a tag whose image is for a runtime the model does not pair with", () => {
      const view = worker({ ...TAGGED, modelRuntimes: { "Pixel 8": ["34"] } });

      expect(matchRequest(view, tagged)).toBeUndefined();
    });

    it("rejects any tag on a catalog that lists no images", () => {
      const view = worker({ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] });

      expect(
        matchRequest(view, { ...tagged, model: "iPhone 17", platform: "ios" }),
      ).toBeUndefined();
    });
  });

  it("matches no download: allowDownload does not make an unlisted runtime pair", () => {
    const view = worker({ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] });

    expect(
      matchRequest(view, {
        allowDownload: true,
        model: "iPhone 17",
        osVersion: "18.0",
        platform: "ios",
      }),
    ).toBeUndefined();
  });
});
