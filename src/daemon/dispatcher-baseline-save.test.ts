import { describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "../contract/index.js";
import type { DispatchSession } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: baseline.save", () => {
  it("ends the held lease, saves its device as version 1 of the named baseline with the files it held, and deletes the device", async () => {
    const { clock, dispatcher, driver, eventBus, registry } = await buildDispatcher();
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/login.txt", "signed in");

    const saved = await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "checkout", note: "app 4.2" },
      session({ role: "admin" }),
    );

    expect(saved).toEqual({
      baseline: {
        mode: "full",
        model: "iPhone 17 Pro",
        name: "checkout",
        note: "app 4.2",
        osVersion: "26.5",
        platform: "ios",
        savedAt: new Date(clock.now()).toISOString(),
        sizeBytes: "signed in".length,
        version: 1,
      },
      leaseId: grant.lease.id,
    });
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["deleted"]);
    const [source] = await driver.listSources();
    expect(driver.sourceFiles(source?.id ?? "")).toEqual(
      new Map([["data/login.txt", "signed in"]]),
    );
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "lease.released")
        .map((envelope) => envelope.payload),
    ).toMatchObject([{ leaseId: grant.lease.id, reason: "explicit" }]);
  });

  it("records the image tag the saved device carries when its lease named none, so a lease naming that tag is granted and another tag is refused", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: {
        availableOsVersions: ["34"],
        defaultImageTag: "google_apis_playstore",
        images: [
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
          { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
        ],
        platform: "android",
      },
    });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "Pixel 8", osVersion: "34", platform: "android" },
      session(),
    );
    const admin = session({ role: "admin" });

    const saved = await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "android-test" },
      admin,
    );
    const listed = await dispatcher.dispatch("baseline.list", {}, admin);
    const named = { baseline: "android-test", platform: "android" };
    const granted = await dispatcher.dispatch(
      "lease.request",
      { ...named, imageTag: "google_apis_playstore" },
      session(),
    );
    await dispatcher.dispatch("lease.release", { leaseId: granted.lease.id }, session());
    const refused = await dispatcher
      .dispatch("lease.request", { ...named, imageTag: "google_apis" }, session())
      .catch((caught: unknown) => caught);

    expect(saved.baseline.imageTag).toBe("google_apis_playstore");
    expect(listed.baselines.map((entry) => entry.imageTag)).toEqual(["google_apis_playstore"]);
    expect(granted.device.spec.baseline).toEqual({ name: "android-test", version: 1 });
    expect(refused).toMatchObject({
      message:
        "baseline android-test is image tag google_apis_playstore, the request asks for google_apis",
    });
  });
});

describe("Dispatcher: baseline.save versions", () => {
  it("numbers each save under one name one more than the last, one at a time or two at once, and keeps only the newest version's source", async () => {
    const { dispatcher, driver, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const lease = async (who: string): Promise<string> => {
      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session({ principal: who }),
      );
      const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
      driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/who", who);
      return grant.lease.id;
    };
    const save = (leaseId: string) =>
      dispatcher.dispatch("baseline.save", { leaseId, name: "checkout" }, admin);
    const keptSources = async () =>
      (await driver.listSources()).map((source) => driver.sourceFiles(source.id));

    const first = await save(await lease("tok_a"));
    const second = await save(await lease("tok_b"));
    expect([first.baseline.version, second.baseline.version]).toEqual([1, 2]);
    expect(await keptSources()).toEqual([new Map([["data/who", "tok_b"]])]);

    const [c, d] = [await lease("tok_c"), await lease("tok_d")];
    const results = await Promise.all([save(c), save(d)]);
    expect(results.map((result) => result.baseline.version).sort()).toEqual([3, 4]);
    const newest =
      results.find((result) => result.baseline.version === 4)?.leaseId === c ? "tok_c" : "tok_d";
    expect(await keptSources()).toEqual([new Map([["data/who", newest]])]);
  });
});

describe("Dispatcher: baseline.save and baseline.remove queue", () => {
  it("runs a remove sent during a save after it, so the remove deletes the version the save made", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { saveSource: 1_000 } },
    });
    const admin = session({ role: "admin" });
    const lease = async (): Promise<string> =>
      (
        await dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
          session(),
        )
      ).lease.id;
    const settled = async (...pending: Promise<unknown>[]): Promise<void> => {
      let open = pending.length;
      for (const promise of pending) void promise.then(() => (open -= 1));
      await vi.waitFor(() => {
        clock.advance(1_000);
        expect(open).toBe(0);
      });
    };
    const first = dispatcher.dispatch(
      "baseline.save",
      { leaseId: await lease(), name: "checkout" },
      admin,
    );
    await settled(first);

    const second = dispatcher.dispatch(
      "baseline.save",
      { leaseId: await lease(), name: "checkout" },
      admin,
    );
    const removed = dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin);
    await settled(second, removed);

    expect(await removed).toEqual({ deletedDevices: [], name: "checkout", versions: [2] });
    expect(await dispatcher.dispatch("baseline.list", {}, admin)).toEqual({ baselines: [] });
    expect(registry.snapshot.leases).toEqual([]);
  });
});

describe("Dispatcher: baseline.save and nuke", () => {
  it("makes nuke wait for a save in flight and remove its baseline, and answers a save queued behind nuke's maintenance with an unknown lease since nuke ended its lease", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { saveSource: 1_000 } },
      includeNuke: true,
    });
    const admin = session({ role: "admin" });
    const lease = async (who: string): Promise<string> =>
      (
        await dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
          session({ principal: who }),
        )
      ).lease.id;
    const [held, queued] = [await lease("tok_a"), await lease("tok_b")];
    const outcome = (promise: Promise<unknown>): { settled: boolean } => {
      const state = { settled: false };
      void promise.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      return state;
    };
    const saving = dispatcher.dispatch("baseline.save", { leaseId: held, name: "first" }, admin);
    const savingState = outcome(saving);
    await vi.waitFor(() => {
      expect(registry.snapshot.devices.map((device) => device.state)).toContain("reclaiming");
    });

    const nuking = dispatcher.dispatch("nuke.run", { deleteDevices: true }, admin);
    const nukeState = outcome(nuking);
    const blocked = dispatcher.dispatch(
      "baseline.save",
      { leaseId: queued, name: "second" },
      admin,
    );
    const blockedError = blocked.then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    await vi.waitFor(() => {
      clock.advance(1_000);
      expect(savingState.settled).toBe(true);
    });
    const [nuked, refusal] = await Promise.all([nuking, blockedError]);

    expect(nukeState.settled).toBe(true);
    expect(nuked).toMatchObject({ releasedLeaseIds: [queued], removedBaselines: ["first"] });
    expect(refusal).toMatchObject({ leaseId: queued, name: "UnknownLeaseError" });
    expect(await dispatcher.dispatch("baseline.list", {}, admin)).toEqual({ baselines: [] });
    expect(registry.snapshot.leases).toEqual([]);
  });
});

describe("Dispatcher: baseline.save failure", () => {
  it("answers BASELINE_SAVE_FAILED when the driver cannot save, with the lease ended, the device quarantined and no baseline recorded", async () => {
    const { dispatcher, driver, eventBus, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const request = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const grant = await dispatcher.dispatch("lease.request", request, session());
    driver.failOn("saveSource", 1, new Error("disk full"));

    const error = await dispatcher
      .dispatch("baseline.save", { leaseId: grant.lease.id, name: "checkout" }, admin)
      .then(
        () => undefined,
        (rejected: unknown) => rejected,
      );

    expect(error).toMatchObject({
      code: "BASELINE_SAVE_FAILED",
      details: { leaseId: grant.lease.id, name: "checkout" },
      message: `baseline checkout was not saved: disk full. Lease ${grant.lease.id} has ended.`,
    });
    expect(registry.snapshot.leases).toEqual([]);
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["quarantined"]);
    expect(await driver.listSources()).toEqual([]);
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "device.quarantined")
        .map((envelope) => envelope.payload),
    ).toMatchObject([{ kind: "shutdown-failed" }]);
    const next = await dispatcher.dispatch("lease.request", request, session());
    const saved = await dispatcher.dispatch(
      "baseline.save",
      { leaseId: next.lease.id, name: "checkout" },
      admin,
    );
    expect(saved.baseline.version).toBe(1);
  });
});

describe("Dispatcher: baseline.save refusals", () => {
  it("refuses a bad name or note, a non-admin, an unknown lease and a physical lease, and ends no lease", async () => {
    const { dispatcher, driver, engine, registry } = await buildDispatcher({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          spec: { class: "tablet", model: "iPad Pro", osVersion: "18.4" },
          state: "ready",
        },
      ],
    });
    await engine.convergeRunningCapacity();
    driver.setPhysicalPresence("00008110-001A2B3C4D5E", true);
    const virtual = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const physical = await dispatcher.dispatch(
      "lease.request",
      { model: "iPad Pro", physical: true, platform: "ios" },
      session({ principal: "tok_physical" }),
    );
    const admin = session({ role: "admin" });
    const accepted = { leaseId: virtual.lease.id, name: "checkout" };
    expect(OPERATIONS["baseline.save"].input.safeParse(accepted).success).toBe(true);

    const refusals: readonly [string, unknown, DispatchSession, string, string?][] = [
      ["Checkout", { ...accepted, name: "Checkout" }, admin, "BAD_REQUEST"],
      ["-checkout", { ...accepted, name: "-checkout" }, admin, "BAD_REQUEST"],
      ["65 characters", { ...accepted, name: "a".repeat(65) }, admin, "BAD_REQUEST"],
      ["201-character note", { ...accepted, note: "n".repeat(201) }, admin, "BAD_REQUEST"],
      ["note with a newline", { ...accepted, note: "two\nlines" }, admin, "BAD_REQUEST"],
      ["an agent token", accepted, session({ role: "agent" }), "FORBIDDEN"],
      ["unknown lease", { ...accepted, leaseId: "lse_gone" }, admin, "UNKNOWN_LEASE"],
      [
        "physical lease",
        { ...accepted, leaseId: physical.lease.id },
        admin,
        "BAD_REQUEST",
        `lease ${physical.lease.id} is on a physical device; only a simulator or emulator can be saved as a baseline`,
      ],
    ];
    for (const [label, input, caller, code, message] of refusals) {
      const error = await dispatcher.dispatch("baseline.save", input as never, caller).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(classifyError(error), label).toBe(code);
      if (message !== undefined) expect((error as Error).message, label).toBe(message);
      expect(registry.snapshot.leases.map((lease) => lease.id).sort(), label).toEqual(
        [virtual.lease.id, physical.lease.id].sort(),
      );
    }
  });
});
