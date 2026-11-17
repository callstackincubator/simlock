import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import {
  DriverCrashError,
  RuntimeMissingError,
  UnsupportedRequestOptionError,
  type VirtualSpec,
} from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { type LeaseRequestOptions } from "./wait-queue.js";
import {
  gibibyte,
  request,
  createHarness,
  seedReady,
  flush,
  settle,
  installs,
} from "./test-lease-acquisition.js";

// why: a test of the coordinator, a part of the decomposed leasing module (ADR 0063 §2), split
// from its own test file.
describe("LeaseAcquisitionCoordinator: missing runtimes", () => {
  it("installs once for two lease requests for the same missing runtime, and grants both", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    const second = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "b",
      requesterId: "b",
    });
    await flush();
    driver.releaseInstalls();

    const grants = await Promise.all([first, second]);
    expect(grants.map((grant) => grant.device.spec.osVersion)).toEqual(["26.5", "26.5"]);
    expect(installs(driver)).toEqual(["26.5"]);
  });

  it("starts the install for a second missing runtime on the same platform only after the first one has ended", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    const second = harness.coordinator.request(
      { ...request, osVersion: "27.0" },
      { allowDownload: true, ownerId: "b", requesterId: "b" },
    );
    await flush();
    expect(installs(driver)).toEqual(["26.5"]);

    driver.releaseInstalls();
    await first;
    await settle();
    expect(installs(driver)).toEqual(["26.5", "27.0"]);
    await expect(second).resolves.toMatchObject({ device: { spec: { osVersion: "27.0" } } });
  });

  it("attributes the install a lease request starts to that request's requester", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ drivers: [driver] });
    const started: unknown[] = [];
    harness.bus.subscribe("component.install-started", (envelope) => {
      started.push(envelope.payload);
    });

    await harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "owner",
      requesterId: "agent-7",
    });

    expect(started).toEqual([{ componentId: "26.5", platform: "ios", requesterId: "agent-7" }]);
  });

  it("starts no install when resolving again fails some other way by the time the request reaches the front, and fails with that error", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const broken = new DriverCrashError("simctl list failed");
    // why: the first resolve finds the runtime missing; the check at the front of the queue breaks.
    driver.failOn("resolveSpec", 2, broken);
    driver.failOn("resolveSpec", 3, broken);
    const harness = await createHarness({ drivers: [driver] });

    await expect(
      harness.coordinator.request(request, { allowDownload: true, ownerId: "a", requesterId: "a" }),
    ).rejects.toBe(broken);
    expect(installs(driver)).toEqual([]);
  });

  it("fails a request without allowDownload for a missing runtime with RuntimeMissingError, and never calls the installer", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const asked: unknown[] = [];
    const harness = await createHarness({
      components: {
        install: async (call) => {
          asked.push(call);
          return { outcome: "installed", version: "26.5" };
        },
      },
      drivers: [driver],
    });

    await expect(
      harness.coordinator.request(request, { ownerId: "a", requesterId: "a" }),
    ).rejects.toMatchObject({ component: "26.5", name: "RuntimeMissingError" });
    expect(asked).toEqual([]);
  });

  it("fails the request with InsufficientDiskSpaceError when the install does not fit, and never calls installComponent", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      componentFootprint: { bytes: 8 * gibibyte, path: "/" },
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver], freeDiskBytes: gibibyte });

    await expect(
      harness.coordinator.request(request, { allowDownload: true, ownerId: "a", requesterId: "a" }),
    ).rejects.toMatchObject({ name: "InsufficientDiskSpaceError" });
    expect(installs(driver)).toEqual([]);
  });
});

describe("LeaseAcquisitionCoordinator: download progress", () => {
  type Progress = Parameters<NonNullable<LeaseRequestOptions["onProgress"]>>[0];

  function downloading(progress: readonly Progress[]): readonly Progress[] {
    return progress.filter((report) => report.stage === "downloading");
  }

  it("tells a request that starts a download downloading, naming the component and not waiting, before provisioning", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(progress[0]).toEqual({ component: "26.5", stage: "downloading", waiting: false });
    const provisioning = progress.findIndex((report) => report.stage === "provisioning");
    expect(provisioning).toBeGreaterThan(0);
    expect(progress.slice(provisioning).some((report) => report.stage === "downloading")).toBe(
      false,
    );
  });

  it("tells a request behind another download on its platform that it is waiting, then not waiting when its own install starts", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });
    const progress: Progress[] = [];

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    const second = harness.coordinator.request(
      { ...request, osVersion: "27.0" },
      {
        allowDownload: true,
        onProgress: (report) => progress.push(report),
        ownerId: "b",
        requesterId: "b",
      },
    );
    await flush();
    expect(progress).toEqual([{ component: "27.0", stage: "downloading", waiting: true }]);

    driver.releaseInstalls();
    await first;
    await settle();
    expect(installs(driver)).toEqual(["26.5", "27.0"]);
    expect(downloading(progress)).toEqual([
      { component: "27.0", stage: "downloading", waiting: true },
      { component: "27.0", stage: "downloading", waiting: false },
      { component: "27.0", percent: 100, stage: "downloading", waiting: false },
    ]);
    await expect(second).resolves.toMatchObject({ device: { spec: { osVersion: "27.0" } } });
  });

  it("tells a request that joins a download already running its latest percentage at once", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: [],
      clock,
      installProgress: [12, 41],
      platform: "ios",
    });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });
    const joined: Progress[] = [];

    const first = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    await flush();
    expect(installs(driver)).toEqual(["26.5"]);
    const second = harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => joined.push(report),
      ownerId: "b",
      requesterId: "b",
    });
    await flush();

    // why: the driver is still holding, so this is the replay, not a later report.
    expect(joined).toEqual([
      { component: "26.5", percent: 41, stage: "downloading", waiting: false },
    ]);
    driver.releaseInstalls();
    await Promise.all([first, second]);
    expect(installs(driver)).toEqual(["26.5"]);
  });

  it.each([
    {
      name: "a percentage the driver reports twice is sent once",
      installProgress: [30, 30, 60],
      percents: [undefined, 30, 60, 100],
    },
    {
      name: "41.7 is sent as 41, and one that rounds down to the last sent is not sent",
      installProgress: [41.7, 41.9],
      percents: [undefined, 41, 100],
    },
    {
      name: "a percentage outside 0 to 100 is sent as the nearest bound, and one that is not a number as no percent",
      installProgress: [10, Number.NaN, -5, 150],
      percents: [undefined, 10, undefined, 0, 100],
    },
  ])(
    "maps the installer's progress to the percentages the requester sees: $name",
    async ({ installProgress, percents }) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: [],
        clock,
        installProgress,
        platform: "ios",
      });
      const harness = await createHarness({ drivers: [driver] });
      const progress: Progress[] = [];

      await harness.coordinator.request(request, {
        allowDownload: true,
        onProgress: (report) => progress.push(report),
        ownerId: "a",
        requesterId: "a",
      });

      expect(downloading(progress)).toEqual(
        percents.map((percent) => ({
          component: "26.5",
          ...(percent === undefined ? {} : { percent }),
          stage: "downloading",
          waiting: false,
        })),
      );
      const complete = progress.findIndex(
        (report) => report.stage === "downloading" && report.percent === 100,
      );
      const provisioning = progress.findIndex((report) => report.stage === "provisioning");
      expect(provisioning).toBeGreaterThan(complete);
      expect(progress.slice(provisioning).some((report) => report.stage === "downloading")).toBe(
        false,
      );
    },
  );

  it("sends no downloading stage to a request whose runtime is installed", async () => {
    const harness = await createHarness();
    const progress: Progress[] = [];

    await harness.coordinator.request(request, {
      allowDownload: true,
      onProgress: (report) => progress.push(report),
      ownerId: "a",
      requesterId: "a",
    });

    expect(progress.map((report) => report.stage)).toContain("provisioning");
    expect(downloading(progress)).toEqual([]);
  });

  it("sends no downloading stage to a request without allowDownload for a missing runtime", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ drivers: [driver] });
    const progress: Progress[] = [];

    await expect(
      harness.coordinator.request(request, {
        onProgress: (report) => progress.push(report),
        ownerId: "a",
        requesterId: "a",
      }),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
    expect(progress).toEqual([]);
  });

  it("tells a request that waited and then needed no install that it was waiting, then provisioning, and never not waiting", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });
    const progress: Progress[] = [];

    const byVersion = harness.coordinator.request(request, {
      allowDownload: true,
      ownerId: "a",
      requesterId: "a",
    });
    // why: no version: the fake names its word for newest, a different component that waits its
    // turn and finds, at the front, that the first install made its runtime available.
    const newest = harness.coordinator.request(
      { model: "iPhone 16", platform: "ios" },
      {
        allowDownload: true,
        onProgress: (report) => progress.push(report),
        ownerId: "b",
        requesterId: "b",
      },
    );
    await flush();
    driver.releaseInstalls();
    await expect(byVersion).resolves.toMatchObject({ device: { spec: { osVersion: "26.5" } } });
    await expect(newest).resolves.toMatchObject({ device: { spec: { osVersion: "26.5" } } });

    expect(installs(driver)).toEqual(["26.5"]);
    expect(progress[0]).toMatchObject({ stage: "downloading", waiting: true });
    expect(
      downloading(progress).every((report) => report.stage === "downloading" && report.waiting),
    ).toBe(true);
    expect(progress[1]).toMatchObject({ stage: "provisioning" });
  });
});

describe("LeaseAcquisitionCoordinator: image tags", () => {
  const android = {
    physical: false,
    model: "Pixel 8",
    osVersion: "34",
    platform: "android",
  } as const;
  const playstore = { ...android, imageTag: "google_apis_playstore" } as const;
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  function taggedDriver(): FakeDriver {
    return new FakeDriver({
      availableOsVersions: ["34", "35"],
      clock: new FakeClock(1_000),
      images: [
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
      ],
      platform: "android",
    });
  }

  it("grants a request naming a tag a device whose spec carries that tag, and one naming none a spec without one", async () => {
    const driver = taggedDriver();
    const harness = await createHarness({ drivers: [driver], maxDevices: 2, maxRunning: 2 });

    const tagged = await harness.coordinator.request(playstore, owner("tagged"));
    const untagged = await harness.coordinator.request(android, owner("untagged"));

    expect(tagged.device.spec).toEqual(playstore);
    expect(untagged.device.spec).toEqual(android);
    const provisioned = driver.calls
      .filter((call) => call.operation === "provision")
      .map((call) => call.arguments[0]);
    expect(provisioned).toEqual([playstore, android]);
  });

  it.each([
    ["without allowDownload", false],
    ["with allowDownload", true],
  ])(
    "fails a tag not installed for the API level with a RuntimeMissingError %s, and never asks the installer",
    async (_label, allowDownload) => {
      const asked: unknown[] = [];
      const harness = await createHarness({
        components: {
          install: async (call) => {
            asked.push(call);
            return { outcome: "installed", version: "35" };
          },
        },
        drivers: [taggedDriver()],
      });

      await expect(
        harness.coordinator.request(
          { ...playstore, osVersion: "35" },
          { ...owner("agent"), allowDownload },
        ),
      ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
      expect(asked).toEqual([]);
    },
  );

  it.each([
    {
      name: "of another tag",
      seeded: { ...android, imageTag: "google_apis" },
      requested: playstore,
    },
    { name: "with no tag", seeded: android, requested: playstore },
    { name: "with a tag when it names none", seeded: playstore, requested: android },
  ] as const)("does not give a request an idle device $name", async ({ seeded, requested }) => {
    const harness = await createHarness({ drivers: [taggedDriver()], maxDevices: 2 });
    const idle = await seedReady(harness, seeded);

    const granted = await harness.coordinator.request(requested, owner("agent"));

    expect(granted.device.id).not.toBe(idle.id);
    expect(granted.device.spec).toEqual(requested);
  });

  it("gives a request naming a tag an idle device of that tag", async () => {
    const harness = await createHarness({ drivers: [taggedDriver()], maxDevices: 2 });
    const tagged = await seedReady(harness, playstore);

    const granted = await harness.coordinator.request(playstore, owner("agent"));

    expect(granted.device.id).toBe(tagged.id);
  });

  it("rejects a request whose driver refuses the image tag as unresolvable-spec, with the driver's error", async () => {
    class NoTagsDriver extends FakeDriver {
      override async resolveSpec(
        ...args: Parameters<FakeDriver["resolveSpec"]>
      ): Promise<VirtualSpec> {
        if (args[0].imageTag !== undefined) {
          throw new UnsupportedRequestOptionError(this.platform, "imageTag");
        }
        return super.resolveSpec(...args);
      }
    }
    const driver = new NoTagsDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({ drivers: [driver] });

    await expect(
      harness.coordinator.request({ ...request, imageTag: "google_apis" }, owner("agent")),
    ).rejects.toBeInstanceOf(UnsupportedRequestOptionError);
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload),
    ).toEqual([
      {
        reason: "unresolvable-spec",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent",
        requestSpec: { ...request, imageTag: "google_apis" },
      },
    ]);
    expect(driver.calls.map((call) => call.operation)).not.toContain("provision");
  });

  it.each([
    ["another tag than the one the request named", playstore, { imageTag: "default" }],
    ["a tag for a request that named none", android, { imageTag: "google_apis" }],
  ] as const)(
    "refuses a spec the driver resolves with %s, and provisions nothing",
    async (_label, asked, returned) => {
      class WrongTagDriver extends FakeDriver {
        override async resolveSpec(
          ...args: Parameters<FakeDriver["resolveSpec"]>
        ): Promise<VirtualSpec> {
          return { ...(await super.resolveSpec(...args)), ...returned };
        }
      }
      const driver = new WrongTagDriver({
        availableOsVersions: ["34"],
        clock: new FakeClock(1_000),
        images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" }],
        platform: "android",
      });
      const harness = await createHarness({ drivers: [driver] });

      await expect(harness.coordinator.request(asked, owner("agent"))).rejects.toThrow(
        /driver resolved image tag .* for a request naming/,
      );
      expect(driver.calls.map((call) => call.operation)).not.toContain("provision");
    },
  );
});

describe("LeaseAcquisitionCoordinator: resolve", () => {
  const installer = () => {
    const asked: unknown[] = [];
    return {
      asked,
      components: {
        install: async (call: unknown) => {
          asked.push(call);
          return { outcome: "installed" as const, version: "26.5" };
        },
      },
    };
  };
  const iphone17 = { model: "iPhone 17", platform: "ios" } as const;
  const driverOf = (options: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
    new FakeDriver({
      availableOsVersions: ["18.0", "18.4", "26.0"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 17"],
      platform: "ios",
      ...options,
    });

  it("resolves a target naming a model and an installed OS to the spec a request for it is granted a device of", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: "26.0" });
    const granted = await harness.coordinator.request(
      { ...iphone17, osVersion: "26.0" },
      { ownerId: "a", requesterId: "a" },
    );

    expect(resolved).toEqual({
      spec: { physical: false, model: "iPhone 17", osVersion: "26.0", platform: "ios" },
    });
    expect(granted.device.spec).toEqual(
      "spec" in resolved ? resolved.spec : { model: "never matches" },
    );
  });

  it("resolves an OS range to the newest installed runtime in it", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: ">=18 <26" });

    expect(resolved).toEqual({
      spec: { physical: false, model: "iPhone 17", osVersion: "18.4", platform: "ios" },
    });
  });

  it("queues nothing, reserves nothing and creates nothing", async () => {
    const driver = driverOf();
    const harness = await createHarness({ drivers: [driver] });

    await harness.coordinator.resolve({ ...iphone17, osVersion: "26.0" });

    expect(harness.coordinator.queueDepth).toBe(0);
    expect(harness.registry.snapshot.devices).toEqual([]);
    expect(
      driver.calls.filter((call) => ["provision", "makeReady"].includes(call.operation)),
    ).toEqual([]);
    await expect(
      harness.coordinator.request(
        { ...iphone17, osVersion: "26.0" },
        { noWait: true, ownerId: "next", requesterId: "next" },
      ),
    ).resolves.toMatchObject({ lease: { requesterId: "next" } });
  });

  it("answers runtime-missing for an OS that is not installed, and never calls the installer though a request could download it", async () => {
    const { asked, components } = installer();
    const driver = driverOf({ availableOsVersions: [] });
    const harness = await createHarness({ components, drivers: [driver] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: "27.0" });

    expect(resolved).toMatchObject({ refusal: "runtime-missing" });
    expect(resolved).toHaveProperty("message", expect.stringContaining("27.0"));
    expect(asked).toEqual([]);
    expect(driver.calls.filter((call) => call.operation === "installComponent")).toEqual([]);
  });

  it("answers runtime-missing for an OS range no installed runtime is in", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: ">=30" });

    expect(resolved).toMatchObject({ refusal: "runtime-missing" });
  });

  it("answers unknown-model for a model the catalog does not list, exact or in a range", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const exact = await harness.coordinator.resolve({
      model: "iPhone 99",
      osVersion: "26.0",
      platform: "ios",
    });
    const ranged = await harness.coordinator.resolve({
      model: "iPhone 99",
      osVersion: ">=18",
      platform: "ios",
    });

    expect(exact).toMatchObject({ refusal: "unknown-model" });
    expect(ranged).toMatchObject({ refusal: "unknown-model" });
  });

  it("answers no-driver for a platform this machine has no driver for", async () => {
    const harness = await createHarness({ drivers: [driverOf()] });

    const resolved = await harness.coordinator.resolve({ model: "Pixel 9", platform: "android" });

    expect(resolved).toMatchObject({ refusal: "no-driver" });
    expect(resolved).toHaveProperty("message", expect.stringContaining("android"));
  });

  it("answers unresolvable with the driver's message when the driver throws any other error", async () => {
    const driver = driverOf();
    driver.failOn("resolveSpec", 1, new Error("the simulator service is down"));
    const harness = await createHarness({ drivers: [driver] });

    const resolved = await harness.coordinator.resolve({ ...iphone17, osVersion: "26.0" });

    expect(resolved).toEqual({
      message: "the simulator service is down",
      refusal: "unresolvable",
    });
  });

  it("gives a slim target on a runtime the driver can slim a slim spec, and one it cannot a full spec", async () => {
    const driver = driverOf({
      availableOsVersions: ["17.5", "26.5"],
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({ drivers: [driver] });

    const slimmable = await harness.coordinator.resolve({
      ...iphone17,
      mode: "slim",
      osVersion: "26.5",
    });
    const below = await harness.coordinator.resolve({
      ...iphone17,
      mode: "slim",
      osVersion: "17.5",
    });

    expect(slimmable).toEqual({
      spec: {
        physical: false,
        mode: "slim",
        model: "iPhone 17",
        osVersion: "26.5",
        platform: "ios",
      },
    });
    expect(below).toEqual({
      spec: { physical: false, model: "iPhone 17", osVersion: "17.5", platform: "ios" },
    });
  });

  it("gives a target naming no mode the worker's default mode, and a full one a full spec", async () => {
    const driver = driverOf({ availableOsVersions: ["26.5"], slimmableOsVersions: ["26.5"] });
    const harness = await createHarness({ defaultModes: { ios: "slim" }, drivers: [driver] });

    const defaulted = await harness.coordinator.resolve({ ...iphone17, osVersion: "26.5" });
    const full = await harness.coordinator.resolve({
      ...iphone17,
      mode: "full",
      osVersion: "26.5",
    });

    expect(defaulted).toMatchObject({ spec: { mode: "slim" } });
    expect(full).toEqual({
      spec: { physical: false, model: "iPhone 17", osVersion: "26.5", platform: "ios" },
    });
  });
});

describe("LeaseAcquisitionCoordinator: levels a model no longer pairs with", () => {
  const pixel = { model: "Pixel 8", physical: false, platform: "android" } as const;
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  class PairingDriver extends FakeDriver {
    override async resolveSpec(
      ...args: Parameters<FakeDriver["resolveSpec"]>
    ): Promise<VirtualSpec> {
      const catalog = await this.listCatalog();
      const { model, osVersion } = args[0];
      if (osVersion !== undefined && !(catalog.modelRuntimes[model] ?? []).includes(osVersion)) {
        throw new RuntimeMissingError("android", osVersion);
      }
      return super.resolveSpec(...args);
    }
  }

  function pairing(): PairingDriver {
    return new PairingDriver({
      availableOsVersions: ["34", "35"],
      clock: new FakeClock(1_000),
      knownModels: ["Pixel 8"],
      modelRuntimes: { "Pixel 8": ["35"] },
      platform: "android",
    });
  }

  it("reuses an idle device on a level the catalog pairs for an exact request", async () => {
    const harness = await createHarness({ drivers: [pairing()], maxDevices: 2 });
    const idle = await seedReady(harness, { ...pixel, osVersion: "35" });

    const granted = await harness.coordinator.request(
      { ...pixel, osVersion: "35" },
      owner("agent"),
    );

    expect(granted.device.id).toBe(idle.id);
  });

  it("does not pick an idle device on a level the catalog no longer pairs for an exact request", async () => {
    const harness = await createHarness({ drivers: [pairing()], maxDevices: 2 });
    const idle = await seedReady(harness, { ...pixel, osVersion: "34" });

    const outcome = await harness.coordinator
      .request({ ...pixel, osVersion: "34" }, owner("agent"))
      .then(
        (granted) => ({ granted: granted.device.id }),
        (error: unknown) => ({ failed: (error as Error).name }),
      );

    expect(outcome).toEqual({ failed: "RuntimeMissingError" });
    expect(harness.registry.snapshot.devices.find((device) => device.id === idle.id)?.state).toBe(
      "ready",
    );
  });

  it("still picks an idle device on a level the catalog no longer pairs for a range request", async () => {
    const harness = await createHarness({ drivers: [pairing()], maxDevices: 2 });
    const idle = await seedReady(harness, { ...pixel, osVersion: "34" });

    const granted = await harness.coordinator.request(
      { model: "Pixel 8", osVersion: ">=34", platform: "android" },
      owner("agent"),
    );

    expect(granted.device.id).toBe(idle.id);
  });
});
