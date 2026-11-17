import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventEnvelope } from "../bus/index.js";
import { plainProjection, removeUsageRigs, T0, usageRig } from "../history/testing.js";
import { Dispatcher } from "./dispatcher.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: baseline events", () => {
  it("records baseline.saved, baseline.removed with its reason (nuke --delete-devices removes every baseline, plain nuke keeps them) and baseline.stale, once each, after the change is committed", async () => {
    const { dispatcher, driver, eventBus, registry, state } = await buildDispatcher({
      driverOptions: { componentSizes: { "27.0": 1_000 }, knownModels: ["iPhone 17 Pro"] },
      includeNuke: true,
    });
    const admin = session({ principal: "tok_admin", role: "admin" });
    // why: what the table held at the moment each event reached a subscriber, to prove the change is committed before the event.
    const seen: { removedRows: number[]; staleReasons: unknown[] } = {
      removedRows: [],
      staleReasons: [],
    };
    eventBus.subscribe("baseline.removed", ({ payload }) => {
      const row = state.database
        .prepare("SELECT COUNT(*) AS count FROM baselines WHERE name = ? AND version = ?")
        .get(payload.name, payload.version);
      seen.removedRows.push(Number(row?.count));
    });
    eventBus.subscribe("baseline.stale", ({ payload }) => {
      const row = state.database
        .prepare("SELECT stale_reason FROM baselines WHERE name = ? AND version = ?")
        .get(payload.name, payload.version);
      seen.staleReasons.push(row?.stale_reason);
    });
    await dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, admin);
    const events = (name: string): unknown[] =>
      eventBus
        .replay()
        .filter((envelope) => envelope.event === name)
        .map((envelope) => envelope.payload);
    const save = async (content: string, name = "checkout"): Promise<string> => {
      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      );
      const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
      driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", content);
      await dispatcher.dispatch("baseline.save", { leaseId: grant.lease.id, name }, admin);
      return grant.lease.id;
    };

    const first = await save("v1");
    expect(events("baseline.saved")).toEqual([
      {
        leaseId: first,
        mode: "full",
        model: "iPhone 17 Pro",
        name: "checkout",
        osVersion: "26.5",
        platform: "ios",
        requesterId: "tok_admin",
        sizeBytes: 2,
        version: 1,
      },
    ]);
    expect(events("device.deleted")).toMatchObject([{ initiator: "baseline-save" }]);
    expect(events("baseline.removed")).toEqual([]);

    await save("v2");
    expect(events("baseline.saved")).toHaveLength(2);
    expect(events("baseline.removed")).toEqual([
      { name: "checkout", reason: "replaced", requesterId: "tok_admin", version: 1 },
    ]);

    const [source] = await driver.listSources();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    const check = async (staleReason?: string): Promise<void> => {
      driver.setSources([
        {
          ...(source as NonNullable<typeof source>),
          ...(staleReason === undefined ? {} : { staleReason }),
        },
      ]);
      await dispatcher.dispatch("baseline.list", {}, admin);
    };
    await check(reason);
    await check(reason);
    expect(events("baseline.stale")).toEqual([{ name: "checkout", reason, version: 2 }]);
    await check();
    await check(reason);
    expect(events("baseline.stale")).toHaveLength(2);

    await check();
    driver.setSources([{ ...(source as NonNullable<typeof source>), staleReason: reason }]);
    await Promise.all([
      dispatcher.dispatch("baseline.list", {}, admin),
      dispatcher.dispatch("baseline.list", {}, admin),
    ]);
    expect(events("baseline.stale")).toHaveLength(3);
    await check();
    driver.setSources([{ ...(source as NonNullable<typeof source>), staleReason: reason }]);
    await dispatcher.dispatch("component.remove", { platform: "ios", version: "27.0" }, admin);
    await vi.waitFor(() => {
      expect(events("baseline.stale")).toHaveLength(4);
    });

    await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin);
    expect(events("baseline.removed")).toEqual([
      { name: "checkout", reason: "replaced", requesterId: "tok_admin", version: 1 },
      { name: "checkout", reason: "operator", requesterId: "tok_admin", version: 2 },
    ]);

    await save("again");
    await save("signed in", "login");
    expect(await dispatcher.dispatch("nuke.run", { deleteDevices: false }, admin)).toMatchObject({
      removedBaselines: [],
    });
    expect((await dispatcher.dispatch("baseline.list", {}, admin)).baselines).toHaveLength(2);
    driver.failOn(
      "destroySource",
      driver.calls.filter((call) => call.operation === "destroySource").length + 1,
      new Error("simctl delete failed"),
    );
    expect(await dispatcher.dispatch("nuke.run", { deleteDevices: true }, admin)).toMatchObject({
      removedBaselines: ["checkout", "login"],
    });
    expect(events("baseline.removed").slice(2)).toEqual([
      { name: "checkout", reason: "nuke", version: 1 },
      { name: "login", reason: "nuke", version: 1 },
    ]);
    expect(await dispatcher.dispatch("baseline.list", {}, admin)).toEqual({ baselines: [] });
    expect(await driver.listSources()).toHaveLength(1);
    expect(seen.removedRows).toEqual([0, 0, 0, 0]);
    expect(seen.staleReasons).toEqual([reason, reason, reason, reason]);
  });
});

describe("Dispatcher: events.replay", () => {
  it("events.replay with sinceTs returns what the event history returns", async () => {
    const fromHistory: EventEnvelope[] = [
      {
        id: "evt_7",
        seq: 7,
        timestamp: 50,
        event: "daemon.stopping",
        payload: { reason: "x" },
        module: "d",
      },
    ];
    const asked: unknown[] = [];
    const { dispatcher } = await buildDispatcher({
      eventHistory: {
        replay: async (input) => {
          asked.push(input);
          return fromHistory;
        },
        replayPage: async () => ({ events: [], kind: "events" }),
        status: () => ({ opened: true, writing: true }),
      },
    });

    await expect(
      dispatcher.dispatch("events.replay", { sinceTs: 10 }, session({ role: "admin" })),
    ).resolves.toEqual(fromHistory);
    expect(asked).toEqual([{ sinceTs: 10 }]);
  });
});

describe("Dispatcher: events.replay paging", () => {
  afterEach(removeUsageRigs);

  const admin = session({ role: "admin" });

  async function pagedRig(
    rows: number,
    options: Parameters<typeof usageRig>[0] = {},
  ): Promise<{
    readonly rig: Awaited<ReturnType<typeof usageRig>>;
    readonly ids: string[];
    readonly dispatcher: Dispatcher;
  }> {
    const rig = await usageRig(options);
    for (let row = 0; row < rows; row += 1) {
      rig.at(T0 + row);
      rig.emit("daemon.stopping", { reason: `r${row + 1}` });
    }
    const { dispatcher } = await buildDispatcher({ eventHistory: rig.history });
    return { dispatcher, ids: rig.bus.replay().map((event) => event.id), rig };
  }

  const reasons = (events: readonly { readonly payload?: unknown }[]): unknown[] =>
    events.map((event) => (event.payload as { reason: string }).reason);

  it("events.replay with beforeId and limit pages through the worker dispatcher over a real history: the page, HISTORY_NOT_KEPT, an empty table, HISTORY_UNAVAILABLE, and 100 at most for beforeId alone", async () => {
    const { dispatcher, ids } = await pagedRig(150);
    const page = await dispatcher.dispatch(
      "events.replay",
      { beforeId: ids[4] as string, limit: 2 },
      admin,
    );
    expect(reasons(page)).toEqual(["r3", "r4"]);
    const unbounded = await dispatcher.dispatch(
      "events.replay",
      { beforeId: ids[149] as string },
      admin,
    );
    expect(unbounded).toHaveLength(100);
    await expect(
      dispatcher.dispatch("events.replay", { beforeId: "evt_gone", limit: 2 }, admin),
    ).rejects.toMatchObject({ code: "HISTORY_NOT_KEPT", details: { oldestTs: T0 } });

    const empty = await pagedRig(0);
    await expect(
      empty.dispatcher.dispatch("events.replay", { beforeId: "evt_any", limit: 2 }, admin),
    ).resolves.toEqual([]);

    const failing = plainProjection("failing", () => ({
      apply: () => {
        throw new Error("projection broke");
      },
      prune: () => undefined,
    }));
    const notWriting = await pagedRig(1, { projections: [failing] });
    expect(notWriting.rig.history.status().writing).toBe(false);
    const unstarted = await buildDispatcher();
    for (const { dispatcher: target } of [notWriting, unstarted]) {
      await expect(
        target.dispatch("events.replay", { beforeId: "evt_any", limit: 2 }, admin),
      ).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });
    }
  });

  it("events.replay with limit alone returns the newest n events, oldest first, through the worker dispatcher", async () => {
    const { dispatcher } = await pagedRig(5);
    const page = await dispatcher.dispatch("events.replay", { limit: 2 }, admin);
    expect(reasons(page)).toEqual(["r4", "r5"]);
  });
});
