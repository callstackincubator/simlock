import { describe, expect, it } from "vitest";
import type { StateDatabase } from "../state/index.js";
import type { DispatchSession } from "./dispatcher.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

/** why: #1207 writes a device's baseline at provision; until then a test writes the registry rows a remove reads. */
function seedBaselineRows(state: StateDatabase): void {
  const { database } = state;
  const spec = ["ios", "iPhone 17 Pro", "26.5", "full"];
  for (const [name, sourceId] of [
    ["login", "src-login"],
    ["checkout", "src-checkout"],
    ["busy", "src-busy"],
  ] as const) {
    database
      .prepare(
        "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES (?, 1, ?, ?, ?, ?, '2026-11-02T13:40:00.000Z', ?)",
      )
      .run(name, ...spec, sourceId);
  }
  for (const [id, fakeId, deviceState, baseline] of [
    ["dev_idle", "fake-ios-1", "shutdown", "checkout"],
    ["dev_idle_b", "fake-ios-4", "shutdown", "checkout"],
    ["dev_leased", "fake-ios-2", "leased", "busy"],
    ["dev_quarantined", "fake-ios-3", "quarantined", "login"],
  ] as const) {
    database
      .prepare(
        "INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version, mode, created_at, baseline_name, baseline_version) VALUES (?, 'ios', 0, ?, ?, 'iPhone 17 Pro', '26.5', 'full', 1, ?, 1)",
      )
      .run(id, fakeId, deviceState, baseline);
    database
      .prepare("INSERT INTO fake_device_data (device_id, fake_device_id) VALUES (?, ?)")
      .run(id, fakeId);
  }
  database
    .prepare(
      "INSERT INTO leases (id, device_id, requester_id, owner_id, granted_at, ttl_ms, ttl_deadline, last_renewed_at, id_chosen_by_requester) VALUES ('lse_busy', 'dev_leased', 'tok_a', 'tok_a', 1, 3600000, 3600001, 1, 0)",
    )
    .run();
}

describe("Dispatcher: baseline.remove", () => {
  it("removes an unused baseline with its source and the idle devices made from it, refuses one a lease uses, an unknown name and an agent", async () => {
    const { dispatcher, driver, engine, registry } = await buildDispatcher({
      seedState: seedBaselineRows,
    });
    const spec = {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      physical: false,
      platform: "ios",
    } as const;
    for (let count = 0; count < 4; count += 1) await driver.provision(spec);
    driver.setSources(
      ["login", "checkout", "busy"].map((name) => ({
        id: `src-${name}`,
        kind: "baseline" as const,
        model: "iPhone 17 Pro",
        osVersion: "26.5",
      })),
    );
    const admin = session({ role: "admin" });
    const refused = async (name: string, caller: DispatchSession): Promise<unknown> =>
      dispatcher.dispatch("baseline.remove", { name }, caller).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
    const listed = async (): Promise<string[]> =>
      (await dispatcher.dispatch("baseline.list", {}, admin)).baselines.map(({ name }) => name);

    expect(await refused("login", session({ role: "agent" }))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await refused("nothere", admin)).toMatchObject({
      code: "UNKNOWN_BASELINE",
      details: { name: "nothere" },
      message: 'no baseline named "nothere" on this worker',
    });
    expect(await refused("Checkout", admin)).toMatchObject({ code: "BAD_REQUEST" });
    expect(await refused("busy", admin)).toMatchObject({
      code: "BASELINE_IN_USE",
      details: { leaseId: "lse_busy", name: "busy" },
      message: "baseline busy is in use by lease lse_busy",
    });
    expect(await listed()).toEqual(["busy", "checkout", "login"]);

    expect(await dispatcher.dispatch("baseline.remove", { name: "login" }, admin)).toEqual({
      deletedDevices: [],
      name: "login",
      versions: [1],
    });
    expect(engine.claimReader.isClaimed("dev_quarantined")).toBe(false);
    // why: the first idle device's destroy throws; the second must still be disposed and no cleanup claim left held.
    driver.failOn("destroy", 1, new Error("destroy failed"));
    await expect(
      dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin),
    ).rejects.toThrow("destroy failed");
    expect(engine.claimReader.isClaimed("dev_idle")).toBe(false);
    expect(engine.claimReader.isClaimed("dev_idle_b")).toBe(false);
    expect(registry.snapshot.devices.map((device) => [device.id, device.state])).toContainEqual([
      "dev_idle_b",
      "deleted",
    ]);
    expect(await listed()).toEqual(["busy", "checkout"]);
    expect(await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin)).toEqual({
      deletedDevices: ["dev_idle"],
      name: "checkout",
      versions: [1],
    });

    expect(await listed()).toEqual(["busy"]);
    expect((await driver.listSources()).map((source) => source.id)).toEqual(["src-busy"]);
    expect(registry.snapshot.devices.map((device) => [device.id, device.state])).toEqual([
      ["dev_idle", "deleted"],
      ["dev_idle_b", "deleted"],
      ["dev_leased", "leased"],
      ["dev_quarantined", "quarantined"],
    ]);
  });
});

describe("Dispatcher: doctor baseline sources", () => {
  it("lists a baseline's source with its name and version, a ready baseline source no row names as an orphan only doctor --purge-orphans deletes, and finds a stale baseline", async () => {
    const { dispatcher, driver, eventBus, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", "abc");
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "checkout" },
      admin,
    );
    const [named] = await driver.listSources();
    const unnamed = {
      id: "left-over",
      kind: "baseline",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
    } as const;
    driver.setSources([named as NonNullable<typeof named>, unnamed]);

    const listed = await dispatcher.dispatch("doctor.run", {}, admin);
    expect(listed.findings).toEqual([]);
    expect(listed.sources).toEqual([
      {
        baselineName: "checkout",
        baselineVersion: 1,
        kind: "baseline",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        platform: "ios",
        sizeBytes: 3,
      },
      {
        kind: "baseline",
        model: "iPhone 17 Pro",
        orphan: true,
        osVersion: "26.5",
        platform: "ios",
      },
    ]);
    expect((await driver.listSources()).map((source) => source.id)).toContain("left-over");

    const purged = await dispatcher.dispatch("doctor.run", { purgeOrphans: true }, admin);
    expect(purged.sources.map((source) => source.orphan)).toEqual([undefined]);
    expect((await driver.listSources()).map((source) => source.id)).not.toContain("left-over");

    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    driver.setSources([{ ...(named as NonNullable<typeof named>), staleReason: reason }]);
    await dispatcher.dispatch("doctor.run", {}, admin);
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "baseline.stale")
        .map((envelope) => envelope.payload),
    ).toEqual([{ name: "checkout", reason, version: 1 }]);
  });
});
