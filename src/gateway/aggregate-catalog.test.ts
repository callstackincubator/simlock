import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../contract/index.js";
import { aggregateCatalog } from "./aggregate.js";
import type { WorkerView } from "./worker-registry.js";
import { view } from "./test-aggregate.js";

// why: pure logic with many cases; the gateway barrel does not export aggregateCatalog, so its cases are asserted here through aggregate.ts.
describe("aggregateCatalog", () => {
  const iosOnA = {
    defaultRuntime: "26.0",
    modelAliases: {},
    classDefaults: {},
    modelClasses: {},
    modelRuntimes: { "iPhone 17": ["26.0"] },
    models: ["iPhone 17"],
    platform: "ios" as const,
    runtimes: ["26.0"],
  };
  // B has 25.4 installed, but only the iPad pairs with it there.
  const iosOnB = {
    defaultRuntime: "26.0",
    modelAliases: {},
    classDefaults: {},
    modelClasses: {},
    modelRuntimes: { "iPad Pro": ["25.4", "26.0"], "iPhone 17": ["26.0"] },
    models: ["iPhone 17", "iPad Pro"],
    platform: "ios" as const,
    runtimes: ["26.0", "25.4"],
  };

  it("leaves a worker with no catalog read, such as one that is starting, out of the union", () => {
    const starting: WorkerView = {
      connection: "connected",
      drained: false,
      health: "starting",
      id: "wrk_s",
      lastSeenAt: 1_000,
    };

    const catalog = aggregateCatalog([starting, view({ catalog: [iosOnA], id: "wrk_a" })]);

    expect(catalog.platforms).toHaveLength(1);
    expect(catalog.platforms[0]?.modelWorkers).toEqual({ "iPhone 17": ["wrk_a"] });
  });

  it("unions the connected workers' catalogs and annotates every entry", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
    expect(catalog.platforms).toHaveLength(1);
    expect(catalog.platforms[0]).toMatchObject({
      models: ["iPad Pro", "iPhone 17"],
      modelWorkers: { "iPad Pro": ["wrk_b"], "iPhone 17": ["wrk_a", "wrk_b"] },
      platform: "ios",
      runtimes: ["25.4", "26.0"],
      runtimeWorkers: { "25.4": ["wrk_b"], "26.0": ["wrk_a", "wrk_b"] },
    });
  });

  it("carries the union of the workers' slim categories, and no default mode", () => {
    const slimming = (slimCategories: string[], defaultMode: "slim" | "full") => ({
      ...iosOnA,
      defaultMode,
      slimCategories,
    });

    const catalog = aggregateCatalog([
      view({ catalog: [slimming(["store", "mdm"], "slim")], id: "wrk_a" }),
      view({ catalog: [slimming(["store", "widgets"], "full")], id: "wrk_b" }),
    ]);

    expect(catalog.platforms[0]?.slimCategories).toEqual(["mdm", "store", "widgets"]);
    expect(catalog.platforms[0]).not.toHaveProperty("defaultMode");
    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
  });

  it("carries the union of the connected workers' model classes, and keeps the class of the first worker in id order when two disagree", () => {
    const classed = (modelClasses: Record<string, "phone" | "tablet" | "tv">) => ({
      ...iosOnB,
      modelClasses,
    });

    // Listed with the later id first, so the answer cannot come from input order.
    const catalog = aggregateCatalog([
      view({ catalog: [classed({ "iPad Pro": "phone", "iPhone 17": "tv" })], id: "wrk_b" }),
      view({ catalog: [classed({ "iPhone 17": "phone" })], id: "wrk_a" }),
      view({
        catalog: [classed({ "iPad Pro": "tablet" })],
        connection: "disconnected",
        id: "wrk_0",
      }),
    ]);

    expect(catalog.platforms[0]?.modelClasses).toEqual({
      "iPad Pro": "phone",
      "iPhone 17": "phone",
    });
    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
  });

  it("drops a model class for a name the worker does not list", () => {
    const catalog = aggregateCatalog([
      view({
        catalog: [{ ...iosOnB, modelClasses: { Ghost: "tv", "iPhone 17": "phone" } }],
        id: "wrk_a",
      }),
    ]);

    expect(catalog.platforms[0]?.modelClasses).toEqual({ "iPhone 17": "phone" });
  });

  it("carries a class default only when every connected worker reports the same one", () => {
    // Every default names a model its worker lists, so a disagreement reaches agreedClassDefaults.
    const withDefaults = (
      classDefaults: Record<string, string>,
      base: typeof iosOnA | typeof iosOnB = iosOnA,
    ) => ({
      ...base,
      classDefaults,
      models: [...new Set([...base.models, "iPad Pro", "iPad (A16)"])],
    });

    const agreed = aggregateCatalog([
      view({ catalog: [withDefaults({ phone: "iPhone 17", tablet: "iPad Pro" })], id: "wrk_a" }),
      view({
        catalog: [withDefaults({ phone: "iPhone 17", tablet: "iPad (A16)" }, iosOnB)],
        id: "wrk_b",
      }),
    ]);

    expect(agreed.platforms[0]?.classDefaults).toEqual({ phone: "iPhone 17" });
    expect(() => OPERATIONS["catalog.get"].output.parse(agreed)).not.toThrow();
  });

  it("drops a class default when a connected worker has none for that class", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [{ ...iosOnA, classDefaults: { phone: "iPhone 17" } }], id: "wrk_a" }),
      view({ catalog: [{ ...iosOnB, classDefaults: {} }], id: "wrk_b" }),
    ]);

    expect(catalog.platforms[0]?.classDefaults).toEqual({});
  });

  it("drops a class default naming a model the worker does not list", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [{ ...iosOnB, classDefaults: { phone: "Ghost" } }], id: "wrk_a" }),
    ]);

    expect(catalog.platforms[0]?.classDefaults).toEqual({});
  });

  it("keeps a class default a lone connected worker reports, and ignores a disconnected worker's", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [{ ...iosOnA, classDefaults: { phone: "iPhone 17" } }], id: "wrk_a" }),
      view({
        catalog: [{ ...iosOnB, classDefaults: { phone: "iPhone 16" } }],
        connection: "disconnected",
        id: "wrk_b",
      }),
    ]);

    expect(catalog.platforms[0]?.classDefaults).toEqual({ phone: "iPhone 17" });
  });

  it("keeps a default runtime only when every worker agrees on it", () => {
    const agreed = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);
    expect(agreed.platforms[0]?.defaultRuntime).toBe("26.0");

    const disagreed = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [{ ...iosOnB, defaultRuntime: "25.4" }], id: "wrk_b" }),
    ]);
    // Picking one at random would make `simlock lease` non-deterministic across an unchanged
    // fleet, so a fleet that disagrees has no default.
    expect(disagreed.platforms[0]?.defaultRuntime).toBeUndefined();
  });

  it("ignores a disconnected worker: a machine nobody can reach can lease nothing", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], connection: "disconnected", id: "wrk_a" }),
    ]);

    expect(catalog.platforms).toEqual([]);
  });

  it("keeps a drained worker, whose models are still installed", () => {
    const catalog = aggregateCatalog([view({ catalog: [iosOnA], drained: true, id: "wrk_a" })]);

    expect(catalog.platforms[0]?.models).toEqual(["iPhone 17"]);
  });

  it("pairs a model with a runtime when at least one connected worker pairs them", () => {
    const iosOnC = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17": ["25.4"] },
      models: ["iPhone 17"],
      platform: "ios" as const,
      runtimes: ["25.4"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnC], id: "wrk_c" }),
    ]);

    expect(catalog.platforms[0]?.modelRuntimes).toEqual({ "iPhone 17": ["25.4", "26.0"] });
  });

  it("does not pair a model with a runtime that only another model has", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    // 25.4 is in the fleet's runtimes, and iPhone 17 is in its models, but no worker pairs them.
    expect(catalog.platforms[0]?.runtimes).toContain("25.4");
    expect(catalog.platforms[0]?.modelRuntimes).toEqual({
      "iPad Pro": ["25.4", "26.0"],
      "iPhone 17": ["26.0"],
    });
  });

  it("ignores the pairings of disconnected and incompatible workers", () => {
    const pairsOld = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17": ["25.4"] },
      models: ["iPhone 17"],
      platform: "ios" as const,
      runtimes: ["25.4"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [pairsOld], connection: "disconnected", id: "wrk_gone" }),
      view({ catalog: [pairsOld], connection: "incompatible", id: "wrk_old" }),
    ]);

    expect(catalog.platforms[0]?.modelRuntimes).toEqual({ "iPhone 17": ["26.0"] });
  });

  it("gives every model in the fleet catalog a modelRuntimes entry, empty when nothing pairs", () => {
    const unpaired = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone XS": [] },
      models: ["iPhone XS"],
      platform: "ios" as const,
      runtimes: ["26.0"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnB], id: "wrk_b" }),
      view({ catalog: [unpaired], id: "wrk_x" }),
    ]);

    const platform = catalog.platforms[0];
    expect(Object.keys(platform?.modelRuntimes ?? {}).sort()).toEqual(
      [...(platform?.models ?? [])].sort(),
    );
    expect(platform?.modelRuntimes["iPhone XS"]).toEqual([]);
  });

  it("treats a model a worker names after an Object.prototype member like any other", () => {
    // Wire input: a worker that lists `constructor` without pairing it must not make the fleet
    // catalog read the inherited function.
    const odd = OPERATIONS["catalog.get"].output.parse({
      platforms: [
        {
          modelAliases: {},
          classDefaults: {},
          modelClasses: {},
          modelRuntimes: {},
          models: ["constructor"],
          platform: "ios",
          runtimes: [],
        },
      ],
    }).platforms;

    const catalog = aggregateCatalog([view({ catalog: odd, id: "wrk_a" })]);

    expect(catalog.platforms[0]?.modelRuntimes).toEqual({ constructor: [] });
  });

  it("drops a pairing with a runtime the worker does not list itself, even when another worker has it", () => {
    const claimsMore = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17": ["25.4", "26.0"] },
      models: ["iPhone 17"],
      platform: "ios" as const,
      runtimes: ["26.0"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [claimsMore], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    // 25.4 is in the fleet (on B, for the iPad only); A's claim to pair it is not A's to make.
    expect(catalog.platforms[0]?.modelRuntimes["iPhone 17"]).toEqual(["26.0"]);
  });

  it("filters to one platform when asked", () => {
    const catalog = aggregateCatalog(
      [
        view({
          catalog: [
            iosOnA,
            {
              modelAliases: {},
              classDefaults: {},
              modelClasses: {},
              modelRuntimes: { "Pixel 9": ["35"] },
              models: ["Pixel 9"],
              platform: "android",
              runtimes: ["35"],
            },
          ],
          id: "wrk_a",
        }),
      ],
      "android",
    );

    expect(catalog.platforms.map((entry) => entry.platform)).toEqual(["android"]);
  });

  describe("other names and images", () => {
    const androidOn = (
      overrides: Partial<{
        models: string[];
        modelAliases: Record<string, string[]>;
        images: { runtime: string; tag: string; abi: string }[];
        runtimes: string[];
        customModels: string[];
        classDefaults: {};
        modelClasses: Record<string, "phone">;
      }>,
    ) => {
      const models = overrides.models ?? ["Pixel 8"];
      const runtimes = overrides.runtimes ?? ["34", "35"];
      return {
        ...(overrides.customModels === undefined ? {} : { customModels: overrides.customModels }),
        ...(overrides.images === undefined ? {} : { images: overrides.images }),
        modelAliases: overrides.modelAliases ?? {},
        classDefaults: {},
        modelClasses: overrides.modelClasses ?? {},
        modelRuntimes: Object.fromEntries(models.map((model) => [model, runtimes])),
        models,
        platform: "android" as const,
        runtimes,
      };
    };

    it("unions other names per model, once per spelling ignoring case", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [androidOn({ modelAliases: { "Pixel 8": ["pixel_8"] } })],
          id: "wrk_a",
        }),
        view({
          catalog: [
            androidOn({
              modelAliases: { "Pixel 8": ["PIXEL_8", "pixel8"], "Pixel 9": ["pixel_9"] },
              models: ["Pixel 8", "Pixel 9"],
            }),
          ],
          id: "wrk_b",
        }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      expect(catalog.platforms[0]?.modelAliases).toEqual({
        "Pixel 8": ["pixel8", "pixel_8"],
        "Pixel 9": ["pixel_9"],
      });
    });

    it("lists each distinct image once", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "x86_64", runtime: "34", tag: "default" },
                { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
              ],
            }),
          ],
          id: "wrk_a",
        }),
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
                { abi: "x86_64", runtime: "35", tag: "google_apis" },
              ],
            }),
          ],
          id: "wrk_b",
        }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      expect(catalog.platforms[0]?.images).toEqual([
        { abi: "x86_64", runtime: "34", tag: "default" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ]);
    });

    it("omits images when no worker reports any", () => {
      const catalog = aggregateCatalog([
        view({ catalog: [iosOnA], id: "wrk_a" }),
        view({ catalog: [iosOnB], id: "wrk_b" }),
      ]);

      expect(catalog.platforms[0]).not.toHaveProperty("images");
    });

    it("does not list a model's own name, in any letter case, as another name for it", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [androidOn({ modelAliases: { "Pixel 8": ["PIXEL 8", "pixel_8"] } })],
          id: "wrk_a",
        }),
      ]);

      expect(catalog.platforms[0]?.modelAliases).toEqual({ "Pixel 8": ["pixel_8"] });
    });

    it("sorts the fleet's images whatever order the workers report them in", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "x86_64", runtime: "35", tag: "google_apis" },
                { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
                { abi: "x86_64", runtime: "34", tag: "default" },
              ],
            }),
          ],
          id: "wrk_a",
        }),
      ]);

      expect(catalog.platforms[0]?.images).toEqual([
        { abi: "x86_64", runtime: "34", tag: "default" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ]);
    });

    it("keeps the fleet catalog inside the contract's bounds when the union of valid workers is not", () => {
      const names = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}${index}`);
      const worker = (prefix: string) =>
        androidOn({
          images: names(prefix, 1024).map((tag) => ({ abi: "x86_64", runtime: "34", tag })),
          modelAliases: {
            ...Object.fromEntries(names(`${prefix}m`, 4095).map((model) => [model, ["x"]])),
            "Pixel 8": names(prefix, 32),
          },
          customModels: ["Pixel 8", ...names(`${prefix}m`, 4095)],
          classDefaults: {},
          modelClasses: Object.fromEntries(
            ["Pixel 8", ...names(`${prefix}m`, 4095)].map((model) => [model, "phone" as const]),
          ),
          models: ["Pixel 8", ...names(`${prefix}m`, 4095)],
        });
      const valid = [worker("a"), worker("b")];
      for (const entry of valid) {
        expect(() => OPERATIONS["catalog.get"].output.parse({ platforms: [entry] })).not.toThrow();
      }

      // Worker b connects first, so what survives the cut is decided by sort order, not arrival.
      const catalog = aggregateCatalog([
        view({ catalog: [valid[1]!], id: "wrk_b" }),
        view({ catalog: [valid[0]!], id: "wrk_a" }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      const platform = catalog.platforms[0];
      expect(platform?.images).toHaveLength(1024);
      expect(platform?.images?.every((image) => image.tag.startsWith("a"))).toBe(true);
      const aliasedModels = Object.keys(platform?.modelAliases ?? {});
      expect(aliasedModels).toHaveLength(4096);
      expect(aliasedModels.filter((model) => model.startsWith("bm"))).toEqual([]);
      expect(platform?.modelAliases["Pixel 8"]).toEqual(names("a", 32).sort());
      expect(platform?.customModels).toHaveLength(4096);
      expect(platform?.customModels?.filter((model) => model.startsWith("bm"))).toEqual([]);
    });

    it("cuts the fleet's model classes by sort order, not arrival order, when the union is over the bound", () => {
      const names = (prefix: string) =>
        Array.from({ length: 4096 }, (_, index) => `${prefix}${index}`);
      const worker = (prefix: string) =>
        androidOn({
          classDefaults: {},
          modelClasses: Object.fromEntries(names(prefix).map((model) => [model, "phone" as const])),
          models: names(prefix),
        });

      // The worker first in id order holds the names that sort last.
      const catalog = aggregateCatalog([
        view({ catalog: [worker("zm")], id: "wrk_a" }),
        view({ catalog: [worker("am")], id: "wrk_b" }),
      ]);

      const classed = Object.keys(catalog.platforms[0]?.modelClasses ?? {});
      expect(classed).toHaveLength(4096);
      expect(classed.every((model) => model.startsWith("am"))).toBe(true);
    });

    it("marks a model custom when one worker marks it and another lists it as built-in", () => {
      const catalog = aggregateCatalog([
        view({ catalog: [androidOn({ models: ["Pixel 8", "My Tablet"] })], id: "wrk_a" }),
        view({
          catalog: [androidOn({ customModels: ["My Tablet"], models: ["My Tablet"] })],
          id: "wrk_b",
        }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      expect(catalog.platforms[0]?.customModels).toEqual(["My Tablet"]);
    });

    it("drops a custom name the worker does not list in models", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [androidOn({ customModels: ["My Tablet", "Ghost"], models: ["My Tablet"] })],
          id: "wrk_a",
        }),
        // Another worker lists Ghost, but only the worker that marks a name can make it custom.
        view({ catalog: [androidOn({ models: ["Ghost"] })], id: "wrk_b" }),
      ]);

      expect(catalog.platforms[0]?.customModels).toEqual(["My Tablet"]);
    });

    it("omits customModels when no worker marks a model it lists", () => {
      const catalog = aggregateCatalog([
        view({ catalog: [androidOn({ customModels: ["Ghost"] })], id: "wrk_a" }),
      ]);

      expect(catalog.platforms[0]).not.toHaveProperty("customModels");
    });

    it("drops an image whose runtime the reporting worker does not list", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "x86_64", runtime: "34", tag: "default" },
                { abi: "x86_64", runtime: "99", tag: "default" },
              ],
            }),
          ],
          id: "wrk_a",
        }),
      ]);

      expect(catalog.platforms[0]?.images).toEqual([
        { abi: "x86_64", runtime: "34", tag: "default" },
      ]);
    });
  });
});
