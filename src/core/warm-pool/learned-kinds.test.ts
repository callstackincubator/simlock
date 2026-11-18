import { describe, expect, it, vi } from "vitest";
import type { PlatformCatalog } from "../driver-catalog.js";
import type { VirtualDevice, VirtualSpec } from "../domain.js";
import type { StateDatabase } from "../../state/index.js";
import { openMemoryState } from "../testing.js";
import type { WarmTarget } from "./config.js";
import { LearnedKinds, warmPoolOwner } from "./learned.js";
import { device, harness, iosListing, minute, now, type BaselineFixture } from "./test-fixtures.js";

// why: the warm pool is a decomposed module (ADR 0063 section 2); these tests drive its converger and learned-kinds parts directly.
describe("warm pool learned kinds", () => {
  const kindsOf = (state: StateDatabase, at = now) => new LearnedKinds(state).kinds(at);
  const granted = (rig: ReturnType<typeof harness>, leaseId: string, deviceId: string): void =>
    void rig.eventBus.emit(
      "lease.granted",
      { deviceId, leaseId, platform: "ios", requestId: "req", requester: "a", source: "warm" },
      "test",
    );

  it("learns on lease.granted the leased device's kind, closes it on lease.released and lease.expired, learns nothing for a device the registry does not hold, and nothing with warmPool.enabled false", async () => {
    const devices = [device("d1", "leased", 0), device("d2", "leased", 0)];
    const learnedWith = async (
      end: "lease.released" | "lease.expired" | undefined,
      options: { enabled?: boolean } = {},
    ) => {
      const state = await openMemoryState([warmPoolOwner]);
      const rig = harness(devices, { ...options, state });
      rig.pool.start();
      granted(rig, "l1", "d1");
      rig.clock.advance(minute);
      if (end === "lease.released") {
        rig.eventBus.emit(
          end,
          { deviceId: "d1", leaseId: "l1", ownerId: "a", reason: "explicit" },
          "test",
        );
      } else if (end === "lease.expired") {
        rig.eventBus.emit(end, { deviceId: "d1", leaseId: "l1", ownerId: "a" }, "test");
      }
      rig.clock.advance(minute);
      granted(rig, "l2", "d2");
      const kinds = kindsOf(state, rig.clock.now());
      rig.pool.dispose();
      return kinds;
    };

    const open = await learnedWith(undefined);
    expect(open.map((kind) => [kind.spec.model, kind.count])).toEqual([["iPhone 15", 2]]);
    const released = await learnedWith("lease.released");
    expect(released.map((kind) => kind.count)).toEqual([1]);
    const expired = await learnedWith("lease.expired");
    expect(expired.map((kind) => kind.count)).toEqual([1]);
    expect(await learnedWith(undefined, { enabled: false })).toEqual([]);

    const state = await openMemoryState([warmPoolOwner]);
    const physical = harness(devices, { state });
    physical.pool.start();
    granted(physical, "l3", "phone-1");
    expect(kindsOf(state)).toEqual([]);
  });

  it("learns a baseline kind only on its Nth lease within 24 hours, a plain kind on its first", async () => {
    const hour = 60 * minute;
    const phone = device("b1", "leased", 0);
    const baselineDevice = (id: string, version: number): VirtualDevice => ({
      ...phone,
      id,
      spec: { ...phone.spec, baseline: { name: "checkout", version } },
    });
    // why: each lease is [hours since the first, device]; the answer is whether its kind is listed after it.
    const run = async (
      leases: readonly (readonly [number, string])[],
      baselineLearnAfter = 3,
      forgetBefore?: number,
    ) => {
      const rig = harness(
        [baselineDevice("v1", 1), baselineDevice("v2", 2), { ...phone, id: "plain" }],
        {
          baselineLearnAfter,
          baselines: { checkout: { version: 2 } },
          catalog: async () => [iosListing],
          limit: 0,
          state: await openMemoryState([warmPoolOwner]),
        },
      );
      rig.pool.start();
      const listed: boolean[] = [];
      let elapsed = 0;
      for (const [index, [at, deviceId]] of leases.entries()) {
        rig.clock.advance(at * hour - elapsed);
        elapsed = at * hour;
        if (index === forgetBefore) rig.pool.forget();
        granted(rig, `l${index}`, deviceId);
        await rig.pool.pass();
        await rig.pool.settle();
        listed.push(
          rig.pool
            .figures()
            .targets.some(
              (target) =>
                target.origin === "learned" &&
                target.baseline === (deviceId === "plain" ? undefined : "checkout"),
            ),
        );
      }
      rig.pool.dispose();
      return listed;
    };

    expect(
      await run([
        [0, "v1"],
        [1, "v1"],
        [2, "v1"],
      ]),
    ).toEqual([false, false, true]);
    expect(
      await run([
        [0, "v1"],
        [1, "v1"],
        [25, "v1"],
        [26, "v1"],
      ]),
    ).toEqual([false, false, false, false]);
    expect(
      await run([
        [0, "v1"],
        [20, "v1"],
        [23, "v1"],
      ]),
    ).toEqual([false, false, true]);
    expect(
      await run([
        [0, "v1"],
        [12, "v1"],
        [24, "v1"],
      ]),
    ).toEqual([false, false, false]);
    expect(
      await run([
        [0, "v1"],
        [1, "v1"],
        [2, "v1"],
        [30, "v1"],
      ]),
    ).toEqual([false, false, true, true]);
    expect(await run([[0, "v1"]], 1)).toEqual([true]);
    expect(
      await run([
        [0, "v1"],
        [1, "v1"],
        [2, "v2"],
      ]),
    ).toEqual([false, false, true]);
    expect(await run([[0, "plain"]])).toEqual([true]);
    expect(
      await run(
        [
          [0, "v1"],
          [1, "v1"],
          [2, "v1"],
          [3, "v1"],
        ],
        3,
        3,
      ),
    ).toEqual([false, false, true, false]);
  });

  it("warms a learned baseline kind as the baseline's newest version: its model, OS, mode, image tag, platform and version, and forgets it on its third failed creation in a row", async () => {
    const stored = { ...device("d1", "ready", 0).spec, baseline: { name: "checkout", version: 1 } };
    const storedAndroid = {
      ...device("d2", "ready", 0, "android").spec,
      baseline: { name: "checkout", version: 1 },
      imageTag: "google_apis",
    };
    const listing: PlatformCatalog = {
      ...iosListing,
      modelRuntimes: { "iPad Pro": ["26.0", "27.0"], "iPhone 15": ["26.0", "27.0"] },
      runtimes: ["26.0", "27.0"],
    };
    const androidListing: PlatformCatalog = {
      ...iosListing,
      images: [
        { abi: "arm64", runtime: "35", tag: "google_apis" },
        { abi: "arm64", runtime: "35", tag: "google_apis_playstore" },
      ],
      modelRuntimes: { "Pixel 8": ["35"] },
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["35"],
    };
    const run = async (learnedAs: VirtualSpec, newest: BaselineFixture) => {
      const state = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(state).learn(learnedAs, "l1", now - minute);
      const rig = harness([], {
        baselines: { checkout: newest },
        catalog: async () => [listing, androidListing],
        state,
      });
      await rig.pool.pass();
      await rig.pool.settle();
      return rig;
    };
    const warmed = (rig: Awaited<ReturnType<typeof run>>) =>
      rig.provisionCalls.map((call) => ({
        baseline: call.spec.baseline,
        imageTag: call.spec.imageTag,
        mode: call.spec.mode,
        model: call.spec.model,
        osVersion: call.spec.osVersion,
        platform: call.spec.platform,
      }));
    const ipad = { model: "iPad Pro" };
    const pixel = { model: "Pixel 8", osVersion: "35", platform: "android" } as const;

    expect(warmed(await run(stored, { ...ipad, version: 2 }))).toEqual([
      {
        baseline: { name: "checkout", version: 2 },
        model: "iPad Pro",
        osVersion: "26.0",
        platform: "ios",
      },
    ]);
    expect(warmed(await run(stored, { osVersion: "27.0", version: 2 }))).toEqual([
      {
        baseline: { name: "checkout", version: 2 },
        model: "iPhone 15",
        osVersion: "27.0",
        platform: "ios",
      },
    ]);
    expect(warmed(await run(stored, { mode: "slim", version: 2 }))).toEqual([
      {
        baseline: { name: "checkout", version: 2 },
        mode: "slim",
        model: "iPhone 15",
        osVersion: "26.0",
        platform: "ios",
      },
    ]);
    expect(
      warmed(await run(storedAndroid, { ...pixel, imageTag: "google_apis_playstore", version: 2 })),
    ).toEqual([
      {
        baseline: { name: "checkout", version: 2 },
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "35",
        platform: "android",
      },
    ]);
    expect(warmed(await run(stored, { ...pixel, imageTag: "google_apis", version: 2 }))).toEqual([
      {
        baseline: { name: "checkout", version: 2 },
        imageTag: "google_apis",
        model: "Pixel 8",
        osVersion: "35",
        platform: "android",
      },
    ]);
    expect(warmed(await run(stored, { version: 2 }))).toEqual([
      {
        baseline: { name: "checkout", version: 2 },
        model: "iPhone 15",
        osVersion: "26.0",
        platform: "ios",
      },
    ]);

    const state = await openMemoryState([warmPoolOwner]);
    new LearnedKinds(state).learn(stored, "l1", now - minute);
    const failing = harness([], {
      baselines: { checkout: { ...ipad, version: 2 } },
      catalog: async () => [listing],
      provision: async () => {
        throw new Error("creation failed");
      },
      state,
    });
    for (let round = 0; round < 3; round += 1) {
      await failing.pool.pass();
      await failing.pool.settle();
      failing.clock.advance(10 * minute);
    }
    expect(new LearnedKinds(state).kinds(failing.clock.now())).toEqual([]);
  });

  it("closes at start() the lease rows the registry no longer holds, and the first pass boots the recorded kinds", async () => {
    const ipad = {
      model: "iPad Pro",
      osVersion: "26.0",
      physical: false,
      platform: "ios",
    } as const;
    const phone = device("d1", "ready", 0).spec;
    const state = await openMemoryState([warmPoolOwner]);
    const previous = new LearnedKinds(state);
    previous.learn(phone, "orphan", now - 30 * minute);
    previous.learn(ipad, "lease-held", now - 10 * minute);
    const held = { ...device("held", "leased", 0), spec: ipad };
    const rig = harness([device("d1", "ready", 0), held], { state });
    rig.lease("held");

    rig.pool.start();
    rig.clock.advance(5 * minute);
    granted(rig, "again-phone", "d1");
    granted(rig, "again-ipad", "held");

    const counts = new LearnedKinds(state)
      .kinds(rig.clock.now())
      .map((kind) => [kind.spec.model, kind.count]);
    expect(counts).toEqual([
      ["iPad Pro", 2],
      ["iPhone 15", 1],
    ]);

    const booting = await openMemoryState([warmPoolOwner]);
    new LearnedKinds(booting).learn(phone, "past", now - 2 * 60 * minute);
    new LearnedKinds(booting).ended("past", now - 60 * minute);
    const restarted = harness([device("shut", "shutdown", 60 * minute)], {
      catalog: async () => [iosListing],
      state: booting,
    });
    restarted.pool.start();
    await restarted.pool.pass();
    await restarted.pool.settle();
    expect(restarted.bootCalls).toEqual(["shut"]);
  });

  it("keeps a learned kind and plans nothing for it while its platform's catalog read is pending, failed or timed out, and boots it as soon as a read lists the platform, without waiting for the next tick", async () => {
    const phone = device("d1", "ready", 0).spec;
    const rigFor = async (catalog: () => Promise<readonly PlatformCatalog[]>) => {
      const state = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(state).learn(phone, "past", now - 2 * 60 * minute);
      new LearnedKinds(state).ended("past", now - 60 * minute);
      return { rig: harness([device("shut", "shutdown", 60 * minute)], { catalog, state }), state };
    };
    const later = () => new Promise((resolve) => setImmediate(resolve));

    let release: (value: readonly PlatformCatalog[]) => void = () => undefined;
    const pending = await rigFor(
      () =>
        new Promise<readonly PlatformCatalog[]>((resolve) => {
          release = resolve;
        }),
    );
    await pending.rig.pool.pass();
    await pending.rig.pool.settle();
    expect(pending.rig.bootCalls).toEqual([]);
    expect(pending.rig.provisionCalls).toEqual([]);
    pending.rig.clock.advance(30_000);
    await pending.rig.pool.pass();
    expect(pending.rig.bootCalls).toEqual([]);
    expect(new LearnedKinds(pending.state).kinds(pending.rig.clock.now())).toHaveLength(1);
    release([iosListing]);
    await later();
    await pending.rig.pool.settle();
    expect(pending.rig.bootCalls).toEqual(["shut"]);

    const failed = await rigFor(async () => {
      throw new Error("avdmanager failed");
    });
    await failed.rig.pool.pass();
    await later();
    await failed.rig.pool.pass();
    await failed.rig.pool.settle();
    expect(failed.rig.bootCalls).toEqual([]);
    expect(failed.rig.provisionCalls).toEqual([]);
    expect(new LearnedKinds(failed.state).kinds(failed.rig.clock.now())).toHaveLength(1);

    const answered = await rigFor(async () => [iosListing]);
    await answered.rig.pool.pass();
    await later();
    await answered.rig.pool.settle();
    expect(answered.rig.bootCalls).toEqual(["shut"]);
  });

  it("forget() empties the record, and the next lease learns its kind again", async () => {
    const phone = device("d1", "ready", 0).spec;
    const state = await openMemoryState([warmPoolOwner]);
    new LearnedKinds(state).learn(phone, "past", now - 2 * minute);
    const rig = harness([device("d1", "leased", 0)], { state });
    rig.pool.start();

    rig.pool.forget();

    expect(new LearnedKinds(state).kinds(rig.clock.now())).toEqual([]);
    granted(rig, "next", "d1");
    expect(new LearnedKinds(state).kinds(rig.clock.now()).map((kind) => kind.count)).toEqual([1]);
  });

  it("starts one catalog read per platform with a learned kind beside a pass, never two at once, forgets a kind whose model, OS, tag image or driver is gone, and keeps a platform's kinds when its read throws or passes 30 s", async () => {
    const phone = device("d1", "ready", 0).spec;
    const catalogOf = (entry: Partial<PlatformCatalog>): PlatformCatalog => ({
      classDefaults: {},
      defaultRuntime: undefined,
      modelAliases: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 15": ["26.0"] },
      models: ["iPhone 15"],
      platform: "ios",
      runtimes: ["26.0"],
      ...entry,
    });
    const run = async (
      answer: (() => Promise<readonly PlatformCatalog[]>) | undefined,
      options: { spec?: VirtualSpec; refused?: boolean } = {},
    ) => {
      const state = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(state).learn(options.spec ?? phone, "l1", now - minute);
      new LearnedKinds(state).ended("l1", now - 30_000);
      const listCatalog = vi.fn(async () => answer?.() ?? []);
      const rig = harness([device("d1", "ready", 0)], {
        catalog: listCatalog,
        state,
        ...(options.refused === true ? { refusedPlatforms: ["ios" as const] } : {}),
      });
      await rig.pool.pass();
      const startedByFirst = listCatalog.mock.calls.length;
      await rig.pool.pass();
      await rig.pool.settle();
      return {
        calls: [startedByFirst, listCatalog.mock.calls.length],
        kinds: new LearnedKinds(state).kinds(rig.clock.now()).length,
        listCatalog,
        rig,
      };
    };

    const listed = await run(async () => [
      catalogOf({ modelRuntimes: {}, models: [], platform: "android" }),
      catalogOf({}),
    ]);
    expect(listed.kinds).toBe(1);
    expect(listed.calls).toEqual([2, 3]);
    listed.rig.clock.advance(30_000);
    expect(
      listed.rig.sink.records.filter(
        (record) => record.message === "a warm pool catalog read took too long",
      ),
    ).toEqual([]);

    const unlistedModel = await run(async () => [catalogOf({ models: [] })]);
    expect(unlistedModel.kinds).toBe(0);
    expect(
      (await run(async () => [catalogOf({ modelRuntimes: { "iPhone 15": ["18.0"] } })])).kinds,
    ).toBe(0);
    const tagged = { ...phone, imageTag: "google_apis" };
    const images = (tag: string, runtime = "26.0") => [{ abi: "arm64", runtime, tag }];
    expect(
      (await run(async () => [catalogOf({ images: images("default") })], { spec: tagged })).kinds,
    ).toBe(0);
    expect(
      (await run(async () => [catalogOf({ images: images("google_apis") })], { spec: tagged }))
        .kinds,
    ).toBe(1);
    expect(
      (
        await run(async () => [catalogOf({ images: images("google_apis", "18.0") })], {
          spec: tagged,
        })
      ).kinds,
    ).toBe(0);
    const refused = await run(async () => [catalogOf({})], { refused: true });
    expect(refused.kinds).toBe(0);
    expect(refused.listCatalog).not.toHaveBeenCalled();

    const throwing = await run(async () => {
      throw new Error("avdmanager failed");
    });
    expect(throwing.kinds).toBe(1);

    const state = await openMemoryState([warmPoolOwner]);
    new LearnedKinds(state).learn(phone, "l1", now - minute);
    new LearnedKinds(state).ended("l1", now - 30_000);
    const releases: ((value: readonly PlatformCatalog[]) => void)[] = [];
    const hanging = vi.fn(
      () =>
        new Promise<readonly PlatformCatalog[]>((resolve) => {
          releases.push(resolve);
        }),
    );
    const rig = harness([device("d1", "ready", 0)], { catalog: hanging, state });
    await rig.pool.pass();
    await rig.pool.pass();
    expect(hanging).toHaveBeenCalledTimes(1);
    rig.clock.advance(30_000 - 1);
    await rig.pool.pass();
    expect(hanging).toHaveBeenCalledTimes(1);
    rig.clock.advance(1);
    await rig.pool.pass();
    expect(hanging).toHaveBeenCalledTimes(2);
    releases[0]?.([catalogOf({ models: [], modelRuntimes: {} })]);
    await rig.pool.pass();
    await rig.pool.settle();
    expect(new LearnedKinds(state).kinds(rig.clock.now())).toHaveLength(1);
    releases[1]?.([catalogOf({ models: [], modelRuntimes: {} })]);
    await rig.pool.pass();
    await rig.pool.settle();
    expect(new LearnedKinds(state).kinds(rig.clock.now())).toHaveLength(0);
  });

  describe("with a learned kind beside the configured targets", () => {
    const phone: WarmTarget = { count: 1, model: "iPhone 15", osVersion: "26.0", platform: "ios" };
    const ipad = {
      model: "iPad Pro",
      osVersion: "26.0",
      physical: false,
      platform: "ios",
    } as const;
    const withLearned = async (counts: number[]) => {
      const state = await openMemoryState([warmPoolOwner]);
      const learned = new LearnedKinds(state);
      learned.learn(ipad, "pad", now - minute);
      counts.forEach((_, index) => {
        learned.learn(device("d1", "ready", 0).spec, `phone-${index}`, now - 2 * minute);
      });
      return state;
    };

    it("shuts down the idle device of an older learned kind for a newer one short for a running slot, and logs the reason displaced", async () => {
      const rig = harness([device("d1", "ready", 30 * minute)], {
        catalog: async () => [iosListing],
        limit: 1,
        maxConcurrentBoots: 2,
        state: await withLearned([1]),
      });

      await rig.pool.pass();
      await rig.pool.settle();

      expect(rig.shutdownCalls).toEqual(["d1"]);
      expect(rig.shutdownArgs).toEqual([["warm-pool", "cleanup"]]);
      expect(
        rig.sink.records
          .filter((record) => record.message === "a warm pool shut a device down")
          .map((record) => record.fields),
      ).toEqual([{ deviceId: "d1", reason: "displaced" }]);
    });

    it("lists a learned kind in figures() with its origin, count, image tag, baseline and short, a merged kind once with the larger count, and drops a forgotten kind or a removed or stale baseline on the next pass", async () => {
      const pixel = { ...device("d2", "ready", 0, "android").spec, imageTag: "google_apis" };
      const state = await openMemoryState([warmPoolOwner]);
      const learned = new LearnedKinds(state);
      learned.learn(ipad, "pad", now - minute);
      learned.learn(pixel, "pixel", now - 3 * minute);
      learned.learn(device("d1", "ready", 0).spec, "phone-0", now - 2 * minute);
      learned.learn(device("d1", "ready", 0).spec, "phone-1", now - 2 * minute);
      const checkout = {
        ...device("d1", "ready", 0).spec,
        baseline: { name: "checkout", version: 1 },
      };
      learned.learn(checkout, "checkout-0", now - 4 * minute);
      const androidListing: PlatformCatalog = {
        ...iosListing,
        images: [{ abi: "arm64", runtime: "35", tag: "google_apis" }],
        modelRuntimes: { "Pixel 8": ["35"] },
        models: ["Pixel 8"],
        platform: "android",
        runtimes: ["35"],
      };
      const rig = harness([], {
        catalog: async () => [iosListing, androidListing],
        limit: 0,
        state,
        baselines: { checkout: { version: 4 } },
        targets: [phone],
      });
      const summary = () =>
        rig.pool.figures().targets.map((target) => ({
          baseline: target.baseline,
          count: target.count,
          imageTag: target.imageTag,
          model: target.model,
          origin: target.origin,
          short: target.short,
        }));

      await rig.pool.pass();
      await rig.pool.settle();

      expect(summary()).toEqual([
        { count: 2, model: "iPhone 15", origin: "configured", short: "running-limit" },
        { count: 1, model: "iPad Pro", origin: "learned", short: "running-limit" },
        {
          count: 1,
          imageTag: "google_apis",
          model: "Pixel 8",
          origin: "learned",
          short: "running-limit",
        },
        {
          baseline: "checkout",
          count: 1,
          model: "iPhone 15",
          origin: "learned",
          short: "running-limit",
        },
      ]);
      const shortLogs = rig.sink.records.filter(
        (record) => record.message === "a warm pool target is short",
      );
      expect(shortLogs.map((record) => record.fields?.target)).toEqual(["ios iPhone 15 26.0"]);

      const copies = harness([], {
        baselines: { checkout: { version: 4 } },
        catalog: async () => [iosListing],
        state,
        targets: [],
      });
      await copies.pool.pass();
      await copies.pool.settle();
      expect(
        copies.provisionCalls
          .map((call) => call.spec.baseline)
          .filter((made) => made !== undefined),
      ).toEqual([{ name: "checkout", version: 4 }]);

      learned.forget(ipad);
      await rig.pool.pass();
      await rig.pool.settle();

      expect(summary().map((entry) => entry.model)).toEqual(["iPhone 15", "Pixel 8", "iPhone 15"]);
      const removed = harness([], {
        catalog: async () => [iosListing],
        limit: 0,
        state,
        targets: [phone],
      });
      await removed.pool.pass();
      await removed.pool.settle();
      await removed.pool.pass();
      expect(
        removed.pool.figures().targets.filter((target) => target.baseline !== undefined),
      ).toEqual([]);
      const staleState = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(staleState).learn(checkout, "checkout-0", now - 4 * minute);
      const stale = harness([], {
        baselines: { checkout: { staleReason: "runtime is not installed", version: 4 } },
        catalog: async () => [iosListing],
        limit: 0,
        state: staleState,
        targets: [phone],
      });
      await stale.pool.pass();
      await stale.pool.settle();
      await stale.pool.pass();
      expect(
        stale.pool.figures().targets.filter((target) => target.baseline !== undefined),
      ).toEqual([]);
      const off = harness([], { enabled: false, state, targets: [phone] });
      expect(off.pool.figures().targets.map((target) => [target.model, target.origin])).toEqual([
        ["iPhone 15", "configured"],
      ]);
      learned.learn(ipad, "pad-again", now - minute);
      const unlearned = harness([], {
        catalog: async () => [iosListing],
        learn: false,
        state,
        targets: [phone],
      });
      await unlearned.pool.pass();
      await unlearned.pool.settle();
      expect(
        unlearned.pool.figures().targets.map((target) => [target.model, target.origin]),
      ).toEqual([["iPhone 15", "configured"]]);
      const fresh = harness([], { state, targets: [phone] });
      expect(fresh.pool.figures().targets.map((target) => [target.model, target.origin])).toEqual([
        ["iPhone 15", "configured"],
      ]);
    });

    it("emits warm-pool.target-missed with origin configured and the configured count, and for no learned kind however short it is", async () => {
      const payloads = (rig: ReturnType<typeof harness>): unknown[] => {
        const seen: unknown[] = [];
        rig.eventBus.subscribe("warm-pool.target-missed", (envelope) =>
          seen.push(envelope.payload),
        );
        return seen;
      };
      const met = harness([device("d1", "ready", 0)], {
        limit: 1,
        state: await withLearned([1, 2]),
        targets: [phone],
      });
      const metPayloads = payloads(met);
      await met.pool.pass();
      await met.pool.settle();
      const empty = harness([], {
        catalog: async () => [iosListing],
        limit: 0,
        state: await withLearned([1, 2]),
        targets: [phone],
      });
      const emptyPayloads = payloads(empty);
      await empty.pool.pass();
      await empty.pool.settle();

      expect(
        empty.pool
          .figures()
          .targets.filter((target) => target.origin === "learned")
          .map((target) => [target.model, target.short]),
      ).toEqual([["iPad Pro", "running-limit"]]);
      expect(metPayloads).toEqual([]);
      expect(emptyPayloads).toEqual([
        {
          count: 1,
          mode: "full",
          model: "iPhone 15",
          origin: "configured",
          osVersion: "26.0",
          platform: "ios",
          ready: 0,
          reason: "running-limit",
        },
      ]);
    });
  });

  describe("when the record fails", () => {
    const failing = (real: StateDatabase, broken: { value: boolean }): StateDatabase => ({
      close: () => real.close(),
      database: {
        close: () => real.database.close(),
        exec: (sql) => {
          if (broken.value) throw new Error("disk I/O error");
          real.database.exec(sql);
        },
        prepare: (sql) => {
          if (broken.value) throw new Error("disk I/O error");
          return real.database.prepare(sql);
        },
      },
      transaction: (work) => {
        if (broken.value) throw new Error("disk I/O error");
        return real.transaction(work);
      },
    });
    const phone = device("d1", "ready", 0).spec;
    const recordWarnings = (rig: ReturnType<typeof harness>, what: string) =>
      rig.sink.records.filter((record) => record.message === `the warm pool's record ${what}`);

    it("logs a LearnedKinds throw once and runs the pass with no learned kinds", async () => {
      const real = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(real).learn(phone, "l1", now - minute);
      const broken = { value: true };
      const rig = harness([device("shut", "shutdown", 60 * minute)], {
        state: failing(real, broken),
        targets: [{ count: 1, model: "iPhone 15", osVersion: "26.0", platform: "ios" }],
      });

      await rig.pool.pass();
      await rig.pool.settle();

      expect(rig.bootCalls).toEqual(["shut"]);
      const passes = rig.waitingDemand.mock.calls.length;
      expect(passes).toBeGreaterThanOrEqual(1);
      expect(recordWarnings(rig, "could not be read")).toHaveLength(passes);
      expect(recordWarnings(rig, "could not be read")[0]).toMatchObject({ level: "warn" });
    });

    it("start() survives a closeOpen throw, and the next pass calls closeOpen again and closes the rows once it succeeds", async () => {
      const real = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(real).learn(phone, "orphan", now - 30 * minute);
      const broken = { value: true };
      const rig = harness([device("d1", "leased", 0)], { state: failing(real, broken) });

      expect(() => rig.pool.start()).not.toThrow();
      expect(recordWarnings(rig, "could not close its open lease rows")).toHaveLength(1);
      broken.value = false;
      await rig.pool.pass();
      rig.clock.advance(5 * minute);
      granted(rig, "again", "d1");

      expect(new LearnedKinds(real).kinds(rig.clock.now()).map((kind) => kind.count)).toEqual([1]);

      new LearnedKinds(real).learn(phone, "ghost", rig.clock.now());
      await rig.pool.pass();

      expect(
        real.database.prepare("SELECT lease_id FROM warm_kind_leases WHERE ended_at IS NULL").all(),
      ).toEqual([{ lease_id: "again" }, { lease_id: "ghost" }]);
    });
  });
});
