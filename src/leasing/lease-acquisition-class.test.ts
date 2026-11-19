import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { type ModelPreferences, RuntimeMissingError, type VirtualSpec } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { IdempotencyConflictError } from "./lease-request-book.js";
import {
  createHarness,
  seedReady,
  flush,
  settle,
  seedShutdown,
  installs,
} from "./test-lease-acquisition.js";

// why: drives the coordinator on its own, so a test can script the catalog and the devices a class request finds in ways the leasing surface cannot force.
describe("LeaseAcquisitionCoordinator: class requests", () => {
  const owner = (id: string) => ({ ownerId: id, requesterId: id });
  const iosModels = ["iPhone 15", "iPhone 16", "iPhone 17", "Apple Watch", "iPad Pro"];
  const iosClasses = {
    "Apple Watch": "watch",
    "iPad Pro": "tablet",
    "iPhone 15": "phone",
    "iPhone 16": "phone",
    "iPhone 17": "phone",
  } as const;
  const iosPreferences: ModelPreferences = {
    ios: {
      phone: ["iPhone 17", "iPhone 16", "iPhone 15"],
      tablet: ["iPad Pro"],
      watch: ["Apple Watch"],
    },
  };
  const phone = { class: "phone", platform: "ios" } as const;
  const iphone15 = {
    physical: false,
    model: "iPhone 15",
    osVersion: "18.4",
    platform: "ios",
  } as const;

  function iosDriver(options: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) {
    return new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(1_000),
      knownModels: iosModels,
      modelClasses: iosClasses,
      platform: "ios",
      ...options,
    });
  }

  function deviceWork(driver: FakeDriver): number {
    return driver.calls.filter((call) => ["provision", "makeReady"].includes(call.operation))
      .length;
  }

  function provisioned(harness: Awaited<ReturnType<typeof createHarness>>) {
    return harness.bus
      .replay()
      .filter((event) => event.event === "device.provisioned")
      .map((event) => (event.payload as { spec: VirtualSpec }).spec);
  }

  async function classHarness(driver = iosDriver(), preferences = iosPreferences) {
    return createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2, preferences });
  }

  it("resolves a request with neither model nor class as the phone class, and lease.requested carries neither", async () => {
    const harness = await classHarness();

    const granted = await harness.coordinator.request({ platform: "ios" }, owner("agent"));

    expect(granted.device.spec).toMatchObject({ model: "iPhone 17", osVersion: "26.5" });
    const requested = harness.bus.replay().filter((event) => event.event === "lease.requested");
    expect(
      requested.map((event) => (event.payload as { requestSpec: unknown }).requestSpec),
    ).toEqual([{ platform: "ios" }]);
  });

  it("grants a phone request one ready idle iPhone 15 with no boot and no provision", async () => {
    const driver = iosDriver();
    const harness = await classHarness(driver);
    const warm = await seedReady(harness, iphone15);
    const before = deviceWork(driver);

    const granted = await harness.coordinator.request(phone, owner("agent"));

    expect(granted.device.id).toBe(warm.id);
    expect(deviceWork(driver)).toBe(before);
  });

  it("does not grant an exact iPhone 16 request a ready idle iPhone 15", async () => {
    const harness = await classHarness();
    const warm = await seedReady(harness, { ...iphone15, osVersion: "26.5" });

    const granted = await harness.coordinator.request(
      { model: "iPhone 16", platform: "ios" },
      owner("agent"),
    );

    expect(granted.device.id).not.toBe(warm.id);
    expect(granted.device.spec.model).toBe("iPhone 16");
  });

  it("does not grant a request with no class a ready idle Apple Watch, and grants a watch request it", async () => {
    const watch = {
      physical: false,
      model: "Apple Watch",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const first = await classHarness();
    const warm = await seedReady(first, watch);

    const noClass = await first.coordinator.request({ platform: "ios" }, owner("agent"));
    expect(noClass.device.id).not.toBe(warm.id);

    const second = await classHarness();
    const warmWatch = await seedReady(second, watch);
    const granted = await second.coordinator.request(
      { class: "watch", platform: "ios" },
      owner("agent"),
    );
    expect(granted.device.id).toBe(warmWatch.id);
  });

  it("boots a shut-down device of the class before creating any device", async () => {
    const driver = iosDriver();
    const harness = await classHarness(driver);
    const cold = await seedShutdown(harness, iphone15);
    const provisions = () => driver.calls.filter((call) => call.operation === "provision").length;
    const before = provisions();

    const granted = await harness.coordinator.request(phone, owner("agent"));

    expect(granted.device.id).toBe(cold.id);
    expect(provisions()).toBe(before);
  });

  describe("device mode", () => {
    const slimming = () =>
      iosDriver({ availableOsVersions: ["26.5"], slimmableOsVersions: ["26.5"] });
    const full15 = { ...iphone15, osVersion: "26.5" } as const;
    const slim15 = { ...full15, mode: "slim" } as const;

    it("never grants a full request a slim device of the class", async () => {
      const harness = await classHarness(slimming());
      const slim = await seedReady(harness, slim15);

      const granted = await harness.coordinator.request({ ...phone, mode: "full" }, owner("agent"));

      expect(granted.device.id).not.toBe(slim.id);
      expect(granted.device.mode).toBe("full");
    });

    it.each([
      { defaultMode: "full", seeded: slim15, name: "a slim device when the default mode is full" },
      { defaultMode: "slim", seeded: full15, name: "a full device when the default mode is slim" },
    ] as const)("does not grant a request with no mode $name", async ({ defaultMode, seeded }) => {
      const harness = await createHarness({
        defaultModes: { ios: defaultMode },
        drivers: [slimming()],
        maxDevices: 2,
        preferences: iosPreferences,
      });
      const idle = await seedReady(harness, seeded);

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.id).not.toBe(idle.id);
      expect(granted.device.mode).toBe(defaultMode);
    });
  });

  describe("image tags", () => {
    const pixel = {
      physical: false,
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    } as const;
    const androidPhone = { class: "phone", platform: "android" } as const;
    const androidPreferences: ModelPreferences = { android: { phone: ["Pixel 9", "Pixel 8"] } };
    const androidDriver = () =>
      new FakeDriver({
        availableOsVersions: ["34", "35"],
        clock: new FakeClock(1_000),
        images: [
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
          { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        ],
        knownModels: ["Pixel 8", "Pixel 9"],
        modelClasses: { "Pixel 8": "phone", "Pixel 9": "phone" },
        modelRuntimes: { "Pixel 8": ["34"], "Pixel 9": ["35"] },
        platform: "android",
      });

    it.each([
      ["of another tag", { imageTag: "google_apis" }, "google_apis_playstore"],
      ["with no tag", {}, "google_apis_playstore"],
    ] as const)(
      "does not grant a request naming a tag an idle device %s",
      async (_label, seeded, asked) => {
        const harness = await classHarness(androidDriver(), androidPreferences);
        const other = await seedReady(harness, { ...pixel, ...seeded });

        const granted = await harness.coordinator.request(
          { ...androidPhone, imageTag: asked },
          owner("agent"),
        );

        expect(granted.device.id).not.toBe(other.id);
        expect(granted.device.spec.imageTag).toBe(asked);
      },
    );

    it("does not grant a request naming no tag an idle device with a tag", async () => {
      const harness = await classHarness(androidDriver(), androidPreferences);
      const tagged = await seedReady(harness, { ...pixel, imageTag: "google_apis_playstore" });

      const granted = await harness.coordinator.request(androidPhone, owner("agent"));

      expect(granted.device.id).not.toBe(tagged.id);
      expect(granted.device.spec).not.toHaveProperty("imageTag");
    });

    it("grants a request naming a tag an idle device of that tag", async () => {
      const harness = await classHarness(androidDriver(), androidPreferences);
      const tagged = await seedReady(harness, { ...pixel, imageTag: "google_apis_playstore" });

      const granted = await harness.coordinator.request(
        { ...androidPhone, imageTag: "google_apis_playstore" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(tagged.id);
    });

    it("skips a candidate whose only pairings carry another tag", async () => {
      const harness = await classHarness(androidDriver(), androidPreferences);

      const granted = await harness.coordinator.request(
        { ...androidPhone, imageTag: "google_apis_playstore" },
        owner("agent"),
      );

      expect(granted.device.spec).toMatchObject({ model: "Pixel 8", osVersion: "34" });
    });
  });

  describe("OS", () => {
    it("fits a class request with no OS to a device on a listed runtime, and not one on a runtime no longer listed", async () => {
      const listed = await classHarness();
      const old = await seedReady(listed, iphone15);
      const grantedListed = await listed.coordinator.request(phone, owner("agent"));
      expect(grantedListed.device.id).toBe(old.id);

      const gone = await classHarness();
      const stale = await seedReady(gone, { ...iphone15, osVersion: "17.0" });
      const grantedGone = await gone.coordinator.request(phone, owner("agent"));
      expect(grantedGone.device.id).not.toBe(stale.id);
      expect(grantedGone.device.spec.osVersion).toBe("26.5");
    });

    it("fits an exact request with no OS only to the runtime the driver picks, as on main", async () => {
      const harness = await classHarness();
      const old = await seedReady(harness, iphone15);

      const granted = await harness.coordinator.request(
        { model: "iPhone 15", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.id).not.toBe(old.id);
      expect(granted.device.spec.osVersion).toBe("26.5");
    });
  });

  describe("OS ranges", () => {
    const rangeDriver = (options: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
      iosDriver({
        availableOsVersions: ["18.0", "18.4", "26.5"],
        modelRuntimes: {
          "iPhone 15": ["18.0", "18.4", "26.5"],
          "iPhone 16": ["18.0", "18.4", "26.5"],
          "iPhone 17": ["26.5"],
        },
        ...options,
      });

    it("sends a class request with no osVersion to the driver without pinning a runtime", async () => {
      const driver = rangeDriver();
      const harness = await classHarness(driver);

      await harness.coordinator.request({ platform: "ios" }, owner("agent"));

      const resolve = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolve?.arguments[0]).toEqual({ mode: "full", model: "iPhone 17", platform: "ios" });
    });

    it("grants a ready idle device whose OS satisfies the range, and not one outside it", async () => {
      const inside = await classHarness(rangeDriver());
      const warm = await seedReady(inside, { ...iphone15, osVersion: "18.0" });
      const grantedInside = await inside.coordinator.request(
        { ...phone, osVersion: ">=18 <26" },
        owner("agent"),
      );
      expect(grantedInside.device.id).toBe(warm.id);

      const outside = await classHarness(rangeDriver());
      const stale = await seedReady(outside, { ...iphone15, osVersion: "26.5" });
      const grantedOutside = await outside.coordinator.request(
        { ...phone, osVersion: ">=18 <26" },
        owner("agent"),
      );
      expect(grantedOutside.device.id).not.toBe(stale.id);
      expect(grantedOutside.device.spec.osVersion).toBe("18.4");
    });

    it("fails an exact model the catalog does not list, sent with a range, at once with UnknownModelError", async () => {
      const driver = rangeDriver();
      const harness = await classHarness(driver);

      await expect(
        harness.coordinator.request(
          { model: "iPhone 99", osVersion: ">=18", platform: "ios" },
          owner("agent"),
        ),
      ).rejects.toMatchObject({ model: "iPhone 99", name: "UnknownModelError" });
      expect(deviceWork(driver)).toBe(0);
    });

    it("grants an exact model with a range a ready idle device of that model in range, and not one of another model", async () => {
      const harness = await classHarness(rangeDriver());
      const other = await seedReady(harness, { ...iphone15, osVersion: "18.0" });
      const same = await seedReady(harness, {
        physical: false,
        model: "iPhone 16",
        osVersion: "18.0",
        platform: "ios",
      });
      const before = deviceWork(harness.driver);

      const granted = await harness.coordinator.request(
        { model: "iPhone 16", osVersion: ">=18 <26", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(same.id);
      expect(granted.device.id).not.toBe(other.id);
      expect(deviceWork(harness.driver)).toBe(before);
    });

    it("fails an exact model with a range at once with UnknownModelError when the platform lists no catalog", async () => {
      const harness = await createHarness({
        catalogReader: { listCatalog: async () => [] },
        drivers: [rangeDriver()],
      });

      await expect(
        harness.coordinator.request(
          { model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          owner("agent"),
        ),
      ).rejects.toMatchObject({ model: "iPhone 16", name: "UnknownModelError" });
    });

    it("never installs for a range even when the driver then reports a downloadable runtime missing", async () => {
      class Racing extends FakeDriver {
        override async resolveSpec(): Promise<VirtualSpec> {
          throw new RuntimeMissingError("ios", "18.4", { component: "18.4" });
        }
      }
      const asked: unknown[] = [];
      const harness = await createHarness({
        components: {
          install: async (call) => {
            asked.push(call);
            return { outcome: "installed", version: "18.4" };
          },
        },
        drivers: [
          new Racing({
            availableOsVersions: ["18.4"],
            clock: new FakeClock(1_000),
            knownModels: ["iPhone 16"],
            modelClasses: { "iPhone 16": "phone" },
            platform: "ios",
          }),
        ],
      });

      await expect(
        harness.coordinator.request(
          { model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          { ...owner("agent"), allowDownload: true },
        ),
      ).rejects.toMatchObject({ name: "RuntimeMissingError" });
      expect(asked).toEqual([]);
    });

    it("creates an exact model with a range on the newest listed pairing in range", async () => {
      const harness = await classHarness(rangeDriver());

      const granted = await harness.coordinator.request(
        { model: "iPhone 16", osVersion: "<26", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "18.4" });
      expect(provisioned(harness).map((spec) => spec.osVersion)).toEqual(["18.4"]);
    });

    it.each([
      ["without allowDownload", false],
      ["with allowDownload", true],
    ])(
      "fails an exact model with a range nothing installed satisfies at once with RuntimeMissingError, not downloadable, naming the range, and never installs, %s",
      async (_label, allowDownload) => {
        const driver = rangeDriver();
        const harness = await classHarness(driver);

        await expect(
          harness.coordinator.request(
            { model: "iPhone 16", osVersion: "<=17", platform: "ios" },
            { ...owner("agent"), allowDownload },
          ),
        ).rejects.toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
          osVersion: "<=17",
        });
        expect(installs(driver)).toEqual([]);
        expect(deviceWork(driver)).toBe(0);
      },
    );

    it.each([["Baklava"], ["34-ext12"]])(
      "reaches resolveSpec with the bare version %s exact, as without ranges, and a range never picks it",
      async (name) => {
        const driver = rangeDriver({
          availableOsVersions: ["18.4", name],
          modelRuntimes: { "iPhone 16": ["18.4", name] },
        });
        const harness = await classHarness(driver);

        await harness.coordinator.request(
          { model: "iPhone 16", osVersion: name, platform: "ios" },
          owner("agent"),
        );
        const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
        expect(resolved?.arguments[0]).toMatchObject({ osVersion: name });

        const ranged = await classHarness(driver);
        const granted = await ranged.coordinator.request(
          { model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          owner("agent"),
        );
        expect(granted.device.spec.osVersion).toBe("18.4");
      },
    );

    it("picks the newest in-range runtime whatever order the catalog lists them in", async () => {
      const harness = await classHarness(
        rangeDriver({
          availableOsVersions: ["18.4", "26.5", "9.3", "18.0"],
          modelRuntimes: { "iPhone 16": ["18.4", "26.5", "9.3", "18.0"] },
        }),
      );

      const granted = await harness.coordinator.request(
        { model: "iPhone 16", osVersion: "<26", platform: "ios" },
        owner("agent"),
      );

      expect(granted.device.spec.osVersion).toBe("18.4");
    });

    it("takes the first class candidate that has an in-range pairing and its newest such runtime: <=18 creates an iPhone 16 on the newest 18.x", async () => {
      const harness = await classHarness(rangeDriver());

      const granted = await harness.coordinator.request(
        { ...phone, osVersion: "<=18" },
        owner("agent"),
      );

      expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "18.4" });
    });

    it.each([
      ["without allowDownload", false],
      ["with allowDownload", true],
    ])(
      "fails a class with a range no candidate pairs with at once with RuntimeMissingError and never installs, %s",
      async (_label, allowDownload) => {
        const driver = rangeDriver();
        const harness = await classHarness(driver);

        await expect(
          harness.coordinator.request(
            { ...phone, osVersion: "<=17" },
            { ...owner("agent"), allowDownload },
          ),
        ).rejects.toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
          osVersion: "<=17",
        });
        expect(installs(driver)).toEqual([]);
      },
    );

    it("does not pick a runtime in range whose only images carry another tag: API 35 default only and API 34 google_apis, >=33 with tag google_apis creates on 34", async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["34", "35"],
        clock: new FakeClock(1_000),
        images: [
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
          { abi: "arm64-v8a", runtime: "35", tag: "default" },
        ],
        knownModels: ["Pixel 8"],
        modelClasses: { "Pixel 8": "phone" },
        modelRuntimes: { "Pixel 8": ["34", "35"] },
        platform: "android",
      });
      const harness = await classHarness(driver, { android: { phone: ["Pixel 8"] } });

      const byModel = await harness.coordinator.request(
        {
          imageTag: "google_apis",
          model: "Pixel 8",
          osVersion: ">=33",
          platform: "android",
        },
        owner("agent"),
      );
      expect(byModel.device.spec).toMatchObject({ imageTag: "google_apis", osVersion: "34" });
    });
  });

  describe("creating a device for a class", () => {
    it("creates the first name on the class's list the catalog lists, and device.provisioned carries that model", async () => {
      const harness = await classHarness();

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.spec.model).toBe("iPhone 17");
      expect(provisioned(harness).map((spec) => spec.model)).toEqual(["iPhone 17"]);
    });

    it.each([
      ["a name the catalog does not list", "Unlisted Phone", {}],
      ["a name of another class", "iPad Pro", {}],
      ["a name with no pairing", "Orphan", { modelRuntimes: { Orphan: [] } }],
    ] as const)("skips %s for the next on the list", async (_label, skipped, driverOptions) => {
      const driver = iosDriver({
        ...driverOptions,
        knownModels: [...iosModels, "Orphan"],
        modelClasses: { ...iosClasses, Orphan: "phone" },
      });
      const harness = await classHarness(driver, {
        ios: { phone: [skipped, "iPhone 16"] },
      });

      const granted = await harness.coordinator.request(phone, owner("agent"));

      expect(granted.device.spec.model).toBe("iPhone 16");
    });

    it.each([
      ["without allowDownload", false],
      ["with allowDownload", true],
    ])(
      "fails a class whose listed models pair with no installed runtime at once with RuntimeMissingError, not downloadable, %s",
      async (_label, allowDownload) => {
        const asked: unknown[] = [];
        const driver = iosDriver({ modelRuntimes: { "iPhone 16": [] } });
        const harness = await createHarness({
          components: {
            install: async (call) => {
              asked.push(call);
              return { outcome: "installed", version: "27.0" };
            },
          },
          drivers: [driver],
          preferences: { ios: { phone: ["iPhone 16"] } },
        });

        await expect(
          harness.coordinator.request(phone, { ...owner("agent"), allowDownload }),
        ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
        expect(asked).toEqual([]);
        expect(deviceWork(driver)).toBe(0);
      },
    );

    it.each([
      ["ios", "ios.defaultModels.phone", { ...phone }],
      ["android", "android.defaultModels.tablet", { class: "tablet", platform: "android" }],
    ] as const)(
      "fails a class with no listed name at once with UnknownModelError naming the class and %s, whatever is idle",
      async (platform, key, asked) => {
        const driver = new FakeDriver({
          availableOsVersions: ["18.4"],
          clock: new FakeClock(1_000),
          knownModels: ["iPhone 15"],
          modelClasses: { "iPhone 15": "phone" },
          platform,
        });
        const harness = await classHarness(driver, {
          [platform]: { phone: ["Unlisted Phone"], tablet: ["Unlisted Tablet"] },
        });
        await seedReady(
          harness,
          platform === "ios"
            ? iphone15
            : { model: "Pixel 8", osVersion: "34", physical: false, platform: "android" },
        );

        await expect(harness.coordinator.request(asked, owner("agent"))).rejects.toMatchObject({
          class: asked.class,
          message: expect.stringContaining(key),
          name: "UnknownModelError",
          platform,
        });
      },
    );

    it("fails a class request at once with UnknownModelError when the platform has no preference list at all", async () => {
      const harness = await classHarness(iosDriver(), {});

      await expect(harness.coordinator.request(phone, owner("agent"))).rejects.toMatchObject({
        class: "phone",
        name: "UnknownModelError",
        message: expect.stringContaining("ios.defaultModels.phone"),
      });
    });

    it("lists a queued class request's class requirement and the catalog's class lookup", async () => {
      const harness = await createHarness({
        drivers: [iosDriver()],
        maxDevices: 1,
        maxRunning: 1,
        preferences: iosPreferences,
      });
      await harness.coordinator.request(phone, owner("holder"));
      void harness.coordinator.request(phone, owner("waiter")).catch(() => undefined);
      await settle();

      const [demand] = harness.coordinator.waitingDemand();

      expect(demand).toMatchObject({
        inFlight: false,
        mode: "full",
        platform: "ios",
        requirement: { platform: "ios", target: { class: "phone", kind: "class" } },
      });
      expect(demand?.classOf("iPhone 15")).toBe("phone");
    });

    it("lists no waiting demand for a request whose class is still being resolved", async () => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const harness = await createHarness({
        catalogReader: {
          listCatalog: async () => {
            await gate;
            return [];
          },
        },
        drivers: [iosDriver()],
        preferences: iosPreferences,
      });

      const pending = harness.coordinator.request(phone, owner("agent"));
      const settled = pending.catch(() => undefined);
      await flush();
      const whileResolving = harness.coordinator.waitingDemand();
      open();
      await settled;

      expect(whileResolving).toEqual([]);
      await expect(pending).rejects.toMatchObject({ name: "UnknownModelError" });
    });

    it.each([
      ["names none", undefined, "default"],
      ["names a version", "18.4", "18.4"],
    ])(
      "names the OS in the RuntimeMissingError of a class whose models pair with no runtime when the request %s",
      async (_label, osVersion, named) => {
        const driver = iosDriver({ modelRuntimes: { "iPhone 16": [] } });
        const harness = await classHarness(driver, { ios: { phone: ["iPhone 16"] } });

        await expect(
          harness.coordinator.request(
            { ...phone, ...(osVersion === undefined ? {} : { osVersion }) },
            owner("agent"),
          ),
        ).rejects.toMatchObject({ name: "RuntimeMissingError", osVersion: named });
      },
    );

    it("fits a class request naming an OS only a device on that OS, and creates a device on it otherwise", async () => {
      const harness = await classHarness();
      const newest = await seedReady(harness, { ...iphone15, osVersion: "26.5" });

      const older = await harness.coordinator.request(
        { ...phone, osVersion: "18.4" },
        owner("agent"),
      );

      expect(older.device.id).not.toBe(newest.id);
      expect(older.device.spec.osVersion).toBe("18.4");

      const sameOs = await classHarness();
      const warm = await seedReady(sameOs, iphone15);
      const granted = await sameOs.coordinator.request(
        { ...phone, osVersion: "18.4" },
        owner("agent"),
      );
      expect(granted.device.id).toBe(warm.id);
    });

    it("fails a class request naming an image tag on a driver with no images with RuntimeMissingError, not downloadable", async () => {
      const harness = await classHarness();

      await expect(
        harness.coordinator.request({ ...phone, imageTag: "google_apis" }, owner("agent")),
      ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
    });

    it("passes the driver an exact model, never a class", async () => {
      const driver = iosDriver();
      const harness = await classHarness(driver);

      await harness.coordinator.request(phone, owner("agent"));

      const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolved?.arguments[0]).toMatchObject({ model: "iPhone 17" });
      expect(resolved?.arguments[0]).not.toHaveProperty("class");
    });
  });

  describe("idempotency", () => {
    const keyed = { ...owner("agent"), idempotencyKey: "key-1" };

    it("returns the stored grant to a repeat of the same class request", async () => {
      const harness = await classHarness();
      const first = await harness.coordinator.request(phone, keyed);

      const second = await harness.coordinator.request(phone, keyed);

      expect(second.lease.id).toBe(first.lease.id);
    });

    it.each([
      ["an exact request", { model: "iPhone 17", platform: "ios" }],
      ["a request of another class", { class: "watch", platform: "ios" }],
      ["a request with neither field", { platform: "ios" }],
    ] as const)("refuses the key of a class request used for %s", async (_label, other) => {
      const harness = await classHarness();
      await harness.coordinator.request(phone, keyed);

      await expect(harness.coordinator.request(other, keyed)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });
  });
});
