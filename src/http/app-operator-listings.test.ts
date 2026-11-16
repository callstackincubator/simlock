import { describe, expect, it } from "vitest";
import { runDispatch } from "../daemon/dispatch.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { agentAuth, buildHarness, operatorAuth, readSseFrames, settle } from "./test-app.js";
import { makeDevice, makeLease } from "./test-fakes.js";

describe("operator-only listing routes", () => {
  it.each([
    ["an agent", agentAuth, { principal: "tok_agent", role: "agent" }],
    ["an operator", operatorAuth, { principal: "tok_operator", role: "admin" }],
  ] as const)(
    "GET /v1/leases dispatches lease.list under %s's own session and answers the handler's leases",
    async (_caller, headers, session) => {
      // Which leases a caller may see is `lease.list`'s rule, owned and tested by the dispatcher;
      // the route's part is to dispatch under the caller's session and return what it answers.
      const { app, dispatcher } = buildHarness();
      const leases = [makeLease({ id: "lse_1", ownerId: "tok_somebody" })];
      dispatcher.handlers["lease.list"] = () => ({ leases });

      const response = await app.request("/v1/leases", { headers });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ leases });
      expect(dispatcher.calls).toEqual([
        expect.objectContaining({
          input: {},
          operation: "lease.list",
          session: expect.objectContaining(session),
        }),
      ]);
    },
  );

  it("GET /v1/lease-requests answers 403 for an agent token", async () => {
    const { app, dispatcher } = buildHarness();
    const waiting = {
      createdAt: 900,
      id: "req_1",
      queuePosition: 1,
      requesterId: "agent-b",
      spec: { model: "iPhone 16", platform: "ios" },
      stage: "queued",
    };
    // `list.get`'s own role check, through the contract's real pipeline: the route adds none.
    dispatcher.handlers["list.get"] = (input, session) =>
      runDispatch("list.get", input, session, {
        handlers: {
          "list.get": (listInput) => {
            expect(listInput).toEqual({ kind: "requests" });
            return [waiting];
          },
        },
      });

    const asAgent = await app.request("/v1/lease-requests", { headers: agentAuth });
    const asOperator = await app.request("/v1/lease-requests", { headers: operatorAuth });

    expect(asAgent.status).toBe(403);
    expect(((await asAgent.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(asOperator.status).toBe(200);
    expect(await asOperator.json()).toEqual({ requests: [waiting] });
  });

  it("GET /v1/devices dispatches list.get(kind: devices)", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["list.get"] = (input) => {
      expect(input).toEqual({ kind: "devices" });
      return [makeDevice({ id: "dev_1" }), makeDevice({ id: "dev_2" })];
    };

    const response = await app.request("/v1/devices", { headers: operatorAuth });
    const body = (await response.json()) as { devices: Array<{ id: string }> };
    expect(body.devices.map((device) => device.id).sort()).toEqual(["dev_1", "dev_2"]);
  });

  it("GET /v1/events replays via events.replay, translating ?since in seconds or days to an absolute sinceTs", async () => {
    const { app, clock, dispatcher } = buildHarness();
    const seen: Array<number | undefined> = [];
    dispatcher.handlers["events.replay"] = (input) => {
      const sinceTs = (input as { sinceTs?: number }).sinceTs;
      seen.push(sinceTs);
      if (sinceTs === undefined) return [{ event: "daemon.started" }, { event: "daemon.stopping" }];
      return [{ event: "daemon.stopping" }];
    };

    const all = await app.request("/v1/events", { headers: operatorAuth });
    expect(((await all.json()) as { events: unknown[] }).events).toHaveLength(2);

    for (const [since, windowMs] of [
      ["5s", 5_000],
      ["2d", 2 * 24 * 60 * 60 * 1000],
    ] as const) {
      const recent = await app.request(`/v1/events?since=${since}`, { headers: operatorAuth });
      const recentBody = (await recent.json()) as { events: Array<{ event: string }> };
      expect(recentBody.events).toEqual([{ event: "daemon.stopping" }]);
      expect(seen.at(-1)).toBe(clock.now() - windowMs);
    }
  });

  it("GET /v1/events with before and limit dispatches events.replay with beforeId and limit, and answers HISTORY_NOT_KEPT with 422 and oldestTs in the body and HISTORY_UNAVAILABLE with 503", async () => {
    const { app, dispatcher } = buildHarness();
    const asked: unknown[] = [];
    dispatcher.handlers["events.replay"] = (input) => {
      asked.push(input);
      throw new DispatchError("HISTORY_NOT_KEPT", "The history does not hold that event.", {
        oldestTs: 1_234,
      });
    };
    const notKept = await app.request("/v1/events?before=evt_abc&limit=50&worker=w1", {
      headers: operatorAuth,
    });
    dispatcher.handlers["events.replay"] = () => {
      throw new DispatchError("HISTORY_UNAVAILABLE", "The history could not be read.");
    };
    const unavailable = await app.request("/v1/events?before=evt_abc", { headers: operatorAuth });

    expect(asked).toEqual([{ beforeId: "evt_abc", limit: 50, workerId: "w1" }]);
    expect(notKept.status).toBe(422);
    expect(await notKept.json()).toMatchObject({
      error: { code: "HISTORY_NOT_KEPT", oldestTs: 1_234 },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "HISTORY_UNAVAILABLE" } });
  });

  it.each([
    ["before=evt_abc&limit=0", "limit must be a whole number from 1 to 500"],
    ["before=evt_abc&limit=501", "limit must be a whole number from 1 to 500"],
    ["before=evt_abc&limit=x", "limit must be a whole number from 1 to 500"],
    ["before=not-an-id", "before must be an event id"],
    ["since=abc", "Invalid duration: abc"],
    ["before=evt_abc&since=1h", "before and since cannot be used together"],
    ["limit=50&since=1h", "limit and since cannot be used together"],
    ["worker=", "worker must be a worker id of 1 to 128 characters"],
    [`worker=${"w".repeat(129)}`, "worker must be a worker id of 1 to 128 characters"],
  ])("GET /v1/events?%s answers 400 BAD_REQUEST before dispatching", async (query, message) => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["events.replay"] = () => {
      throw new Error("should not be called");
    };

    const response = await app.request(`/v1/events?${query}`, { headers: operatorAuth });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST", message } });
  });

  describe("GET /v1/stats", () => {
    const NOW = Date.parse("2026-10-16T12:00:00Z");
    const HOUR = 3_600_000;

    function statsHarness() {
      const harness = buildHarness();
      harness.clock.advance(NOW - harness.clock.now());
      const asked: { from: number; to: number; includeLedger?: boolean }[] = [];
      harness.dispatcher.handlers["usage.get"] = (input) => {
        asked.push(input as never);
        return { window: input };
      };
      const get = (query: string) =>
        harness.app.request(`/v1/stats${query}`, { headers: operatorAuth });
      return { ...harness, asked, get };
    }

    it("dispatches usage.get for since back from now, from to to, from to now, and the last 24 hours with no parameter", async () => {
      const { asked, get } = statsHarness();

      const answered = await get("?since=1h");
      await get("?from=2026-10-15T00:00Z&to=2026-10-16T00:00Z");
      await get("?from=2026-10-15T00:00Z");
      await get("");

      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ window: { from: NOW - HOUR, to: NOW } });
      expect(asked.map(({ from, to }) => ({ from, to }))).toEqual([
        { from: NOW - HOUR, to: NOW },
        { from: Date.parse("2026-10-15T00:00Z"), to: Date.parse("2026-10-16T00:00Z") },
        { from: Date.parse("2026-10-15T00:00Z"), to: NOW },
        { from: NOW - 24 * HOUR, to: NOW },
      ]);
    });

    it("answers 400 with the Inputs table's message for since with from, to without from, from not before to, a bad duration, the times 1, 2026, 10/15/2026, no zone and an unencoded +, and ledger other than 1, each after the same query without the fault answered 200, and answers 200 for %2B02:00", async () => {
      const { asked, get } = statsHarness();
      const time = "from=2026-10-15T00:00Z";
      const timeMessage = (value: string) =>
        `Invalid time: ${value} (use ISO 8601 with Z or an offset)`;
      const cases: readonly (readonly [string, string, string])[] = [
        [`?since=1h&${time}`, "?since=1h", "stats takes since or from, not both"],
        ["?to=2026-10-16T00:00Z", `?${time}&to=2026-10-16T00:00Z`, "to needs from"],
        [
          "?from=2026-10-16T00:00Z&to=2026-10-15T00:00Z",
          "?from=2026-10-15T00:00Z&to=2026-10-16T00:00Z",
          "from must be earlier than to, or than now when to is left out",
        ],
        ["?since=fortnight", "?since=1h", "Invalid duration: fortnight"],
        ["?from=1", `?${time}`, timeMessage("1")],
        ["?from=2026", `?${time}`, timeMessage("2026")],
        ["?from=10/15/2026", `?${time}`, timeMessage("10/15/2026")],
        ["?from=2026-10-15T00:00", `?${time}`, timeMessage("2026-10-15T00:00")],
        ["?from=2026-10-15T00:00+02:00", `?${time}`, timeMessage("2026-10-15T00:00 02:00")],
        ["?since=1h&ledger=yes", "?since=1h&ledger=1", "ledger must be 1"],
      ];

      for (const [bad, good, message] of cases) {
        expect((await get(good)).status, good).toBe(200);
        const dispatched = asked.length;
        const refused = await get(bad);
        expect(refused.status, bad).toBe(400);
        expect(await refused.json(), bad).toMatchObject({
          error: { code: "BAD_REQUEST", message },
        });
        expect(asked, bad).toHaveLength(dispatched);
      }
      const offset = await get("?from=2026-10-15T00:00%2B02:00");
      expect(offset.status).toBe(200);
      expect(asked.at(-1)).toEqual({ from: Date.parse("2026-10-14T22:00:00Z"), to: NOW });
    });

    it("passes includeLedger: true only for ledger=1", async () => {
      const { asked, get } = statsHarness();

      await get("?since=1h");
      await get("?since=1h&ledger=1");

      expect(asked.map((input) => input.includeLedger === true)).toEqual([false, true]);
    });
  });

  it("GET /v1/events/stream dispatches events.subscribe then follows the raw event bus live", async () => {
    const { app, dispatcher, eventBus } = buildHarness();
    dispatcher.handlers["events.subscribe"] = (_input, session) => ({
      subscribed: true,
      subscriptionId: session.manageEventSubscription(true),
    });
    const streamResponse = await app.request("/v1/events/stream", { headers: operatorAuth });
    // `dispatch("events.subscribe", ...)` is awaited before the SSE stream opens, so it has
    // already run by the time `app.request` resolves.
    expect(dispatcher.calls.some((c) => c.operation === "events.subscribe")).toBe(true);
    const framesPromise = readSseFrames(streamResponse, 1);
    await Promise.resolve();
    eventBus.emit("daemon.stopping", { reason: "live" }, "test");
    const frames = await framesPromise;
    expect(frames[0]?.event).toBe("daemon.stopping");
  });

  it("GET /v1/events/stream writes a comment or retry line as soon as it opens, before any keepalive is due", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["events.subscribe"] = (_input, session) => ({
      subscribed: true,
      subscriptionId: session.manageEventSubscription(true),
    });
    const response = await app.request("/v1/events/stream", { headers: operatorAuth });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("response has no body");
    let written = "nothing written";
    void reader.read().then(({ value, done }) => {
      written = done ? "stream ended" : new TextDecoder().decode(value);
    });
    for (let turn = 0; turn < 50; turn += 1) await settle();
    const writtenBeforeCancel = written;
    await reader.cancel();

    expect(writtenBeforeCancel).toMatch(/^(:[^\n]*|retry: ?\d+)\n\n$/);
  });
});
