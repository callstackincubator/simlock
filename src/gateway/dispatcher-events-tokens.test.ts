import { describe, expect, it } from "vitest";
import { type EventEnvelope } from "../bus/index.js";
import { fixedEventHistory, usageRig } from "../history/testing.js";
import { harness, session } from "./test-dispatcher.js";

describe("GatewayDispatcher", () => {
  it("replays and subscribes to its own bus, which carries the fleet's events", async () => {
    const { dispatcher, eventBus } = harness();
    eventBus.emit(
      "lease.granted",
      {
        deviceId: "dev_1",
        leaseId: "l1",
        platform: "ios",
        requester: "a",
        requestId: "req_1",
        source: "warm",
      },
      "worker",
    );

    await expect(dispatcher.dispatch("events.replay", {}, session())).resolves.toEqual([
      expect.objectContaining({ event: "lease.granted" }),
    ]);
    await expect(dispatcher.dispatch("events.subscribe", {}, session())).resolves.toEqual({
      subscribed: true,
      subscriptionId: "sub_1",
    });
  });

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
    const { dispatcher } = harness({
      eventHistory: {
        replay: async (input) => {
          asked.push(input);
          return fromHistory;
        },
        replayPage: async () => ({ events: [], kind: "events" }),
        status: () => ({ opened: true, writing: true }),
      },
    });

    await expect(dispatcher.dispatch("events.replay", { sinceTs: 10 }, session())).resolves.toEqual(
      fromHistory,
    );
    expect(asked).toEqual([{ sinceTs: 10 }]);
  });

  it("events.replay with beforeId returns a worker's relayed event with payload.workerId", async () => {
    const rig = await usageRig({ fleet: true });
    rig.relay("w-1", "daemon.stopping", { reason: "from-worker" });
    rig.emit("daemon.stopping", { reason: "local" });
    const newest = rig.bus.replay().at(-1) as { id: string };
    const { dispatcher } = harness({ eventHistory: rig.history });

    const page = await dispatcher.dispatch(
      "events.replay",
      { beforeId: newest.id, limit: 5 },
      session(),
    );

    expect(page).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ workerId: "w-1" }) }),
    ]);
  });

  it("events.replay with limit alone returns the newest n events, oldest first, through the gateway dispatcher", async () => {
    const rig = await usageRig({ fleet: true });
    for (const reason of ["a", "b", "c"]) rig.emit("daemon.stopping", { reason });
    const { dispatcher } = harness({ eventHistory: rig.history });

    const page = await dispatcher.dispatch("events.replay", { limit: 2 }, session());

    expect(page.map((event) => (event.payload as { reason: string }).reason)).toEqual(["b", "c"]);
  });

  it("events.replay with beforeId and no limit returns at most 100 events through the gateway dispatcher", async () => {
    const rig = await usageRig({ fleet: true });
    for (let n = 0; n < 130; n += 1) rig.emit("daemon.stopping", { reason: `r${n}` });
    const newest = rig.bus.replay().at(-1) as { id: string };
    const { dispatcher } = harness({ eventHistory: rig.history });

    const page = await dispatcher.dispatch("events.replay", { beforeId: newest.id }, session());

    expect(page).toHaveLength(100);
  });

  it.each([
    {
      health: "running" as const,
      history: { opened: true, setAsideAt: 1_760_605_920_000, writing: false },
    },
    { health: "starting" as const, history: { opened: false, writing: false } },
    { health: "running" as const, history: { opened: true, writing: true } },
    {
      health: "running" as const,
      history: { opened: true, rebuiltAt: 1_760_605_920_000, writing: true },
    },
    {
      health: "running" as const,
      history: { opened: true, rebuildFailed: true as const, writing: true },
    },
  ])(
    "status.get carries the gateway's own history opened, writing, setAsideAt, rebuiltAt and rebuildFailed, in the starting answer too ($health, $history)",
    async ({ health, history }) => {
      const { dispatcher } = harness({ eventHistory: fixedEventHistory(history), health });

      const status = await dispatcher.dispatch("status.get", {}, session());

      expect((status as { history?: unknown }).history).toStrictEqual(history);
    },
  );

  it("mints its own tokens, worker join tokens included", async () => {
    const { dispatcher, tokens } = harness();

    await expect(
      dispatcher.dispatch("token.create", { role: "worker", label: "mac-mini-1" }, session()),
    ).resolves.toMatchObject({ secret: "slk_secret", token: { role: "worker" } });
    expect(tokens.created).toEqual(["worker"]);
  });

  it("closes the uplink a revoked token authorized, not merely the store entry (C-2)", async () => {
    const { closedUplinkTokens, dispatcher } = harness();

    await expect(dispatcher.dispatch("token.revoke", { id: "tok_1" }, session())).resolves.toEqual({
      revoked: true,
    });

    expect(closedUplinkTokens).toEqual(["tok_1"]);
  });

  it("does not try to close an uplink for a token id that was never real (C-2)", async () => {
    const { closedUplinkTokens, dispatcher } = harness();

    await expect(
      dispatcher.dispatch("token.revoke", { id: "tok_unknown" }, session()),
    ).resolves.toEqual({ revoked: false });

    expect(closedUplinkTokens).toEqual([]);
  });
});
