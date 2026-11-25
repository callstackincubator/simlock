import { describe, expect, it } from "vitest";

import {
  catalogFixture,
  deviceFixture,
  hostFixture,
  physicalDeviceFixture,
  statusFixture,
} from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { warmHit } from "./warm-hit.js";

type ViewDeviceSpec = NonNullable<WorkerView["devices"]>[number]["spec"];

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
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios" as const,
    };

    expect(warmHit.score(view("leased"), request)).toBe(0);
    expect(warmHit.score(view("ready"), request)).toBe(1);
  });

  it("scores 0 for a worker whose only ready device that fits the request is physical", () => {
    const physical = {
      class: "phone" as const,
      id: "dev_p",
      physical: true,
      servesDefaultMode: true,
      spec: { model: "iPhone 17", osVersion: "26.0", physical: true, platform: "ios" as const },
      state: "ready" as const,
    };
    const view = (devices: NonNullable<WorkerView["devices"]>): WorkerView => ({
      capacity: statusFixture().capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      connection: "connected",
      devices,
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const request = { model: "iPhone 17", platform: "ios" as const };

    expect(warmHit.score(view([physical]), request)).toBe(0);
    expect(warmHit.score(view([physical, deviceFixture("dev_v", "ready")]), request)).toBe(1);
  });

  it("ranks a tagless Android request by a ready device with the worker's default image tag on the newest level that has an image of it, else as it came", () => {
    const device = (id: string, osVersion: string, imageTag?: string) => ({
      ...deviceFixture(id, "ready"),
      spec: {
        physical: false,
        model: "Pixel 9",
        osVersion,
        platform: "android" as const,
        ...(imageTag === undefined ? {} : { imageTag }),
      },
    });
    const view = (
      devices: NonNullable<WorkerView["devices"]>,
      defaultImageTag: string | undefined,
      baselines?: WorkerView["baselines"],
      images = [
        { abi: "arm64-v8a", runtime: "36", tag: "google_apis_playstore" },
        { abi: "arm64-v8a", runtime: "37", tag: "google_apis" },
      ],
    ): WorkerView => ({
      ...(baselines === undefined ? {} : { baselines }),
      capacity: statusFixture().capacity,
      catalog: catalogFixture([
        {
          ...(defaultImageTag === undefined ? {} : { defaultImageTag }),
          images,
          models: ["Pixel 9"],
          platform: "android",
          runtimes: ["35", "36", "37"],
        },
      ]).platforms,
      connection: "connected",
      devices,
      drained: false,
      host: hostFixture(),
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const playstore = "google_apis_playstore";
    const request = { model: "Pixel 9", platform: "android" as const };

    expect(warmHit.score(view([device("d1", "36", playstore)], playstore), request)).toBe(1);
    expect(warmHit.score(view([device("d1", "37")], playstore), request)).toBe(0);
    expect(warmHit.score(view([device("d1", "37")], undefined), request)).toBe(1);
    expect(warmHit.score(view([device("d1", "36", playstore)], undefined), request)).toBe(0);
    const named = { ...request, imageTag: "google_apis" };
    expect(warmHit.score(view([device("d1", "37", "google_apis")], playstore), named)).toBe(1);
    expect(warmHit.score(view([device("d1", "36", playstore)], playstore), named)).toBe(0);
    // why: B7 — a request naming a baseline ranks as today, so the default tag does not narrow it.
    const saved = {
      mode: "full" as const,
      model: "Pixel 9",
      name: "smoke",
      osVersion: "36",
      platform: "android" as const,
      savedAt: "2026-11-02T13:10:00Z",
      version: 2,
    };
    const copy = {
      ...device("d1", "36"),
      spec: { ...device("d1", "36").spec, baseline: { name: "smoke", version: 2 } },
    };
    const baselined = { ...request, baseline: "smoke" };
    expect(warmHit.score(view([copy], playstore, [saved]), baselined)).toBe(1);
    // why: I4 — no serving model has an image of the default tag, so the request ranks as it came.
    const onlyApis = [{ abi: "arm64-v8a", runtime: "37", tag: "google_apis" }];
    expect(warmHit.score(view([device("d1", "37")], playstore, undefined, onlyApis), request)).toBe(
      1,
    );
    // why: I4 — the tag steers to the newest level with an image of it, so an older level is no hit.
    const twoLevels = [
      { abi: "arm64-v8a", runtime: "35", tag: playstore },
      { abi: "arm64-v8a", runtime: "36", tag: playstore },
    ];
    const old = view([device("d1", "35", playstore)], playstore, undefined, twoLevels);
    expect(warmHit.score(old, request)).toBe(0);
    // why: I7 — only an image built for the worker's CPU (arm64 here) counts for the default tag, so an x86_64 image of it leaves the request as it came.
    const otherCpu = [
      { abi: "x86_64", runtime: "37", tag: playstore },
      { abi: "arm64-v8a", runtime: "37", tag: "google_apis" },
    ];
    expect(warmHit.score(view([device("d1", "37")], playstore, undefined, otherCpu), request)).toBe(
      1,
    );
    // why: I4, I7 — the newest level is the newest of the worker's CPU, so another CPU's newer image does not move it.
    const cpuLevels = [
      { abi: "arm64-v8a", runtime: "35", tag: playstore },
      { abi: "x86_64", runtime: "36", tag: playstore },
    ];
    const armView = view([device("d1", "35", playstore)], playstore, undefined, cpuLevels);
    expect(warmHit.score(armView, request)).toBe(1);
    // why: I7 — a host that is not arm64 counts x86_64 images, not arm64-v8a ones.
    const x86Levels = [
      { abi: "arm64-v8a", runtime: "37", tag: playstore },
      { abi: "x86_64", runtime: "36", tag: playstore },
    ];
    const x86View = {
      ...view([device("d1", "36", playstore)], playstore, undefined, x86Levels),
      host: hostFixture({ arch: "x64" }),
    };
    expect(warmHit.score(x86View, request)).toBe(1);
  });

  it("counts no device as warm on a worker whose devices were never read", () => {
    const unread: WorkerView = {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      connection: "connected",
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
    };

    expect(warmHit.score(unread, { model: "iPhone 17", platform: "ios" })).toBe(0);
  });

  it("counts a ready device as warm only on the request's platform and the runtime it names", () => {
    const ready = deviceFixture("dev_1", "ready");
    const view = (spec: Partial<ViewDeviceSpec>): WorkerView => ({
      capacity: statusFixture().capacity,
      catalog: catalogFixture([
        {
          defaultRuntime: "26.0",
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0", "18.0"],
        },
      ]).platforms,
      connection: "connected",
      devices: [{ ...ready, spec: { ...ready.spec, ...spec } }],
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const request = { model: "iPhone 17", platform: "ios" as const };

    expect(warmHit.score(view({ platform: "android" }), request)).toBe(0);
    expect(warmHit.score(view({ osVersion: "18.0" }), { ...request, osVersion: "26.0" })).toBe(0);
    expect(warmHit.score(view({ osVersion: "18.0" }), request)).toBe(0);
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
    const request = { osVersion: "26.0", platform: "ios" as const };

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
      physical: false,
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

  describe("mode", () => {
    const view = (device: ReturnType<typeof deviceFixture>): WorkerView => ({
      capacity: statusFixture().capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      connection: "connected",
      devices: [device],
      drained: false,
      id: "wrk_a",
      lastSeenAt: 1,
      leases: [],
    });
    const request = {
      physical: false,
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios" as const,
    };

    it("does not count a slim device as warm for a full request, nor a full device for a slim one", () => {
      expect(
        warmHit.score(view(deviceFixture("d", "ready", "slim")), { ...request, mode: "full" }),
      ).toBe(0);
      expect(
        warmHit.score(view(deviceFixture("d", "ready", "full")), { ...request, mode: "slim" }),
      ).toBe(0);
      expect(
        warmHit.score(view(deviceFixture("d", "ready", "slim")), { ...request, mode: "slim" }),
      ).toBe(1);
      expect(
        warmHit.score(view(deviceFixture("d", "ready", "full")), { ...request, mode: "full" }),
      ).toBe(1);
    });

    it("counts a device as warm for a request naming no mode only when it reports servesDefaultMode", () => {
      expect(warmHit.score(view(deviceFixture("d", "ready", "slim", true)), request)).toBe(1);
      expect(warmHit.score(view(deviceFixture("d", "ready", "full", false)), request)).toBe(0);
      expect(warmHit.score(view(deviceFixture("d", "ready", "slim", false)), request)).toBe(0);
    });
  });

  describe("runtime the worker would pick", () => {
    const view = (
      catalog: Parameters<typeof catalogFixture>[0][number],
      osVersion: string,
    ): WorkerView => {
      const device = deviceFixture("d", "ready");
      return {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([catalog]).platforms,
        connection: "connected",
        devices: [{ ...device, spec: { ...device.spec, osVersion } }],
        drained: false,
        id: "wrk_a",
        lastSeenAt: 1,
        leases: [],
      };
    };
    const request = { model: "iPhone 17", platform: "ios" as const };

    it("does not count a warm device on a runtime other than the one the worker would pick for a request naming no runtime", () => {
      const catalog = {
        defaultRuntime: "26.0",
        models: ["iPhone 17"],
        platform: "ios" as const,
        runtimes: ["26.0", "18.0"],
      };

      expect(warmHit.score(view(catalog, "18.0"), request)).toBe(0);
      expect(warmHit.score(view(catalog, "26.0"), request)).toBe(1);
    });

    it("counts a warm device on the runtime a request names even when it is not the worker's default", () => {
      const catalog = {
        defaultRuntime: "26.0",
        models: ["iPhone 17"],
        platform: "ios" as const,
        runtimes: ["26.0", "18.0"],
      };

      expect(warmHit.score(view(catalog, "18.0"), { ...request, osVersion: "18.0" })).toBe(1);
      expect(warmHit.score(view(catalog, "26.0"), { ...request, osVersion: "18.0" })).toBe(0);
    });

    it("gives no warm hit on a platform the worker's catalog does not list", () => {
      const catalog = {
        models: ["Pixel 8"],
        platform: "android" as const,
        runtimes: ["35"],
      };

      expect(warmHit.score(view(catalog, "26.0"), request)).toBe(0);
    });

    it("picks the model's only paired runtime when the default runtime does not pair with the model", () => {
      const catalog = {
        defaultRuntime: "26.0",
        modelRuntimes: { "iPhone 17": ["18.0"] },
        models: ["iPhone 17"],
        platform: "ios" as const,
        runtimes: ["26.0", "18.0"],
      };

      expect(warmHit.score(view(catalog, "18.0"), request)).toBe(1);
      expect(warmHit.score(view(catalog, "26.0"), request)).toBe(0);
    });

    it("picks the newest paired runtime for a request naming no runtime when no default runtime pairs and several runtimes do", () => {
      const catalog = {
        models: ["iPhone 17"],
        platform: "ios" as const,
        runtimes: ["26.0", "18.0"],
      };

      expect(warmHit.score(view(catalog, "26.0"), request)).toBe(1);
      expect(warmHit.score(view(catalog, "18.0"), request)).toBe(0);
    });
  });

  describe("a class or range request", () => {
    const catalog = {
      defaultRuntime: "26.0",
      modelClasses: { "iPad Pro": "tablet", "iPhone 15": "phone", "iPhone 17": "phone" } as const,
      models: ["iPad Pro", "iPhone 15", "iPhone 17"],
      platform: "ios" as const,
      runtimes: ["18.0", "26.0"],
    };
    const view = (
      spec: Partial<ViewDeviceSpec>,
      device: Partial<ReturnType<typeof deviceFixture>> = {},
    ): WorkerView => {
      const ready = deviceFixture("d", "ready");
      return {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([catalog]).platforms,
        connection: "connected",
        devices: [{ ...ready, ...device, spec: { ...ready.spec, ...spec } }],
        drained: false,
        id: "wrk_a",
        lastSeenAt: 1,
        leases: [],
      };
    };
    const phone = { class: "phone" as const, platform: "ios" as const };

    it("counts a ready device of another model in the requested class as warm, and one of another class as not", () => {
      expect(warmHit.score(view({ model: "iPhone 15" }), phone)).toBe(1);
      expect(warmHit.score(view({ model: "iPad Pro" }), phone)).toBe(0);
      expect(warmHit.score(view({ model: "iPad Pro" }), { ...phone, class: "tablet" })).toBe(1);
      expect(warmHit.score(view({ model: "iPhone 15" }), { platform: "ios" })).toBe(1);
      expect(warmHit.score(view({ model: "iPad Pro" }), { platform: "ios" })).toBe(0);
    });

    it("counts a ready device on any version as warm for a class request naming none", () => {
      expect(warmHit.score(view({ osVersion: "18.0" }), phone)).toBe(1);
      expect(warmHit.score(view({ osVersion: "26.0" }), phone)).toBe(1);
    });

    it("does not count a ready device whose OS is outside the range as warm", () => {
      expect(warmHit.score(view({ osVersion: "18.0" }), { ...phone, osVersion: ">=26" })).toBe(0);
      expect(warmHit.score(view({ osVersion: "26.0" }), { ...phone, osVersion: ">=26" })).toBe(1);
      expect(warmHit.score(view({ osVersion: "26.0" }), { ...phone, osVersion: "<=18" })).toBe(0);
      expect(warmHit.score(view({ osVersion: "18.0" }), { ...phone, osVersion: "18 - 19" })).toBe(
        1,
      );
    });

    it("does not count a device in a mode the request refuses as warm", () => {
      const slim = deviceFixture("d", "ready", "slim", false);

      expect(warmHit.score(view({}, slim), { ...phone, mode: "full" })).toBe(0);
      expect(warmHit.score(view({}, slim), phone)).toBe(0);
      expect(warmHit.score(view({}, slim), { ...phone, mode: "slim" })).toBe(1);
    });

    it("does not count a device of another image tag as warm for a class request", () => {
      expect(warmHit.score(view({ imageTag: "x" }), phone)).toBe(0);
    });

    it("counts a ready device of the model a request names as warm inside a range, and none outside it", () => {
      const exact = { model: "iPhone 17", platform: "ios" as const };

      expect(warmHit.score(view({}), { ...exact, osVersion: ">=26" })).toBe(1);
      expect(warmHit.score(view({}), { ...exact, osVersion: "<26" })).toBe(0);
      expect(warmHit.score(view({ model: "iPhone 15" }), { ...exact, osVersion: ">=18" })).toBe(0);
    });
  });
});

describe("warm-hit with a baseline", () => {
  const entry = {
    mode: "full" as const,
    model: "iPhone 17",
    name: "smoke",
    osVersion: "26.0",
    platform: "ios" as const,
    savedAt: "2026-11-02T13:10:00Z",
    version: 2,
  };
  const copyOf = (version: number): NonNullable<WorkerView["devices"]>[number] => {
    const device = deviceFixture("dev_1", "ready");
    return { ...device, spec: { ...device.spec, baseline: { name: "smoke", version } } };
  };
  const worker = (
    devices: NonNullable<WorkerView["devices"]>,
    mode: "slim" | "full" = "full",
  ): WorkerView => ({
    baselines: [{ ...entry, mode }],
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    connection: "connected",
    devices,
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
  });

  it("takes the baseline's mode for a request naming none, as the copy's own mode", () => {
    const slimCopy = { ...copyOf(2), mode: "slim" as const, servesDefaultMode: false };

    expect(warmHit.score(worker([slimCopy], "slim"), { baseline: "smoke", platform: "ios" })).toBe(
      1,
    );
    expect(warmHit.score(worker([slimCopy], "full"), { baseline: "smoke", platform: "ios" })).toBe(
      0,
    );
  });

  it.each([
    ["a ready copy of the current version, for the baseline", [copyOf(2)], "smoke", 1],
    ["a ready copy of an older version, for the baseline", [copyOf(1)], "smoke", 0],
    ["a ready copy of the baseline, for a plain request", [copyOf(2)], undefined, 0],
  ] as const)("counts only %s as a warm hit", (_label, devices, baseline, score) => {
    const request = {
      platform: "ios" as const,
      ...(baseline === undefined ? {} : { baseline }),
    };

    expect(warmHit.score(worker([...devices]), request)).toBe(score);
  });
});

describe("warm-hit's zero reason", () => {
  const worker: WorkerView = {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
  };

  it("gives no-free-physical for a physical request the worker has no pickable device for, and nothing for a virtual one", () => {
    const physical = { model: "iPhone 17", physical: true as const, platform: "ios" as const };
    const virtual = { model: "iPhone 17", platform: "ios" as const };
    const pickable = {
      ...worker,
      devices: [physicalDeviceFixture("dev_p", "ready", { model: "iPhone 17" })],
    };

    expect(warmHit.zeroReason?.(worker, physical)).toEqual({ reason: "no-free-physical" });
    expect(warmHit.zeroReason?.(pickable, physical)).toBeUndefined();
    expect(warmHit.zeroReason?.(worker, virtual)).toBeUndefined();
  });
});
