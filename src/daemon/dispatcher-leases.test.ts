import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { type Config, UnknownLeaseError } from "../core/index.js";
import { RequestCancelledError } from "../leasing/index.js";
import { buildDispatcher, gibibyte, session } from "./test-dispatcher.js";

describe("Dispatcher: ownership", () => {
  async function grantLease(dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"]) {
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    return (grant as { lease: { id: string } }).lease.id;
  }

  it.each([
    ["a non-admin session", { principal: "tok_agent", role: "agent" }],
    [
      "a plain admin session (not the gateway's uplink)",
      { principal: "tok_operator", role: "admin" },
    ],
  ] as const)(
    "lease.request: rejects %s naming owner with FORBIDDEN, never silently ignoring it (ADR §27a, H7, H3)",
    async (_name, who) => {
      const { dispatcher } = await buildDispatcher();

      await expect(
        dispatcher.dispatch(
          "lease.request",
          {
            model: "iPhone 17 Pro",
            osVersion: "26.5",
            owner: "someone-else",
            platform: "ios",
          },
          session({ ...who }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("lease.request: the gateway's own uplink session may set owner, and the granted lease ends up owned by that, not the uplink's own principal (ADR §27a, H3)", async () => {
    const { dispatcher } = await buildDispatcher();

    const grant = await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        owner: "agent-7",
        platform: "ios",
      },
      session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
    );

    expect((grant as { lease: { ownerId: string } }).lease.ownerId).toBe("agent-7");
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId: (grant as { lease: { id: string } }).lease.id },
        session({ principal: "tok_gateway", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId: (grant as { lease: { id: string } }).lease.id },
        session({ principal: "agent-7", role: "agent" }),
      ),
    ).resolves.toMatchObject({ id: (grant as { lease: { id: string } }).lease.id });
  });

  describe("lease.request's fleetRequestId (ADR 0021)", () => {
    const probeInput = {
      fleetRequestId: "req_gw1",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;

    it.each([
      ["with noWait: true", { ...probeInput, noWait: true }],
      ["without noWait", probeInput],
    ])(
      "refuses it from a session that is not the gateway uplink with FORBIDDEN and stores nothing, %s",
      async (_label, input) => {
        const { dispatcher, registry } = await buildDispatcher();

        for (const refused of [
          session({ principal: "tok_agent", role: "agent" }),
          session({ principal: "tok_operator", role: "admin" }),
        ]) {
          await expect(dispatcher.dispatch("lease.request", input, refused)).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("fleetRequestId"),
          });
        }

        expect(registry.leaseRequests()).toEqual([]);
        expect(registry.snapshot.leases).toEqual([]);
      },
    );

    it("refuses it without noWait: true from the gateway uplink with BAD_REQUEST and stores nothing", async () => {
      const { dispatcher, registry } = await buildDispatcher();

      await expect(
        dispatcher.dispatch(
          "lease.request",
          probeInput,
          session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("noWait"),
      });

      expect(registry.leaseRequests()).toEqual([]);
    });

    it("stores it on the request when the gateway uplink sends it with noWait: true", async () => {
      const { dispatcher, registry } = await buildDispatcher();

      await dispatcher.dispatch(
        "lease.request",
        { ...probeInput, noWait: true },
        session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
      );

      expect(registry.leaseRequests()).toEqual([
        expect.objectContaining({ fleetRequestId: "req_gw1", state: "granted" }),
      ]);
    });
  });

  it("a worker with no gateway accepts a request's metadata and stores and emits none of it", async () => {
    const { dispatcher, eventBus, registry } = await buildDispatcher();

    const grant = await dispatcher.dispatch(
      "lease.request",
      { metadata: { project: "checkout-app" }, model: "iPhone 17", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    expect(grant.lease.id).toBeDefined();
    expect(registry.leaseRequests().length, "the request is stored").toBeGreaterThan(0);
    expect(JSON.stringify(registry.leaseRequests()), "the stored request").not.toContain(
      "checkout-app",
    );
    expect(JSON.stringify(registry.snapshot), "the registry").not.toContain("checkout-app");
    expect(JSON.stringify(eventBus.replay()), "the events").not.toContain("checkout-app");
  });

  it("lease.renew: rejects a non-owner with FORBIDDEN, admits the owner, admin bypasses", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.renew", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ id: leaseId });
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "admin" }),
      ),
    ).resolves.toMatchObject({ id: leaseId });
  });

  it("lease.release: rejects a non-owner with FORBIDDEN, admits the owner", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.release",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.release", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ leaseId });
  });

  it("lease.list: an agent sees only its own leases, admin sees all", async () => {
    const { dispatcher } = await buildDispatcher();
    await grantLease(dispatcher);

    const own = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_owner", role: "agent" }),
    );
    expect(own.leases).toHaveLength(1);
    expect(own.leases[0]).not.toHaveProperty("workerLeaseId");

    const otherAgent = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_other", role: "agent" }),
    );
    expect(otherAgent.leases).toHaveLength(0);

    const admin = await dispatcher.dispatch("lease.list", {}, session({ role: "admin" }));
    expect(admin.leases).toHaveLength(1);
  });

  it("lease.get: an agent reads its own lease, another agent's or an unknown id is UNKNOWN_LEASE, admin reads any", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);
    const owner = session({ principal: "tok_owner", role: "agent" });

    const own = await dispatcher.dispatch("lease.get", { leaseId }, owner);
    expect(own).toEqual({ lease: (await dispatcher.dispatch("lease.list", {}, owner)).leases[0] });
    expect(own.lease).toMatchObject({ id: leaseId, ownerId: "tok_owner" });
    await expect(
      dispatcher.dispatch(
        "lease.get",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toBeInstanceOf(UnknownLeaseError);
    await expect(
      dispatcher.dispatch("lease.get", { leaseId: "lse_nope" }, owner),
    ).rejects.toBeInstanceOf(UnknownLeaseError);
    await expect(
      dispatcher.dispatch(
        "lease.get",
        { leaseId },
        session({ principal: "tok_other", role: "admin" }),
      ),
    ).resolves.toMatchObject({ lease: { id: leaseId } });
  });

  it("status.get: an agent sees only the leases and waiting requests it owns, one that owns none sees empty lists, admin sees all", async () => {
    const { dispatcher, engine } = await buildDispatcher();
    const IOS = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const ask = (principal: string, requesterId: string) =>
      dispatcher.dispatch(
        "lease.request",
        { ...IOS, requesterId },
        session({ principal, role: "agent" }),
      );
    // why: two leases fill iOS (maxRunning: 2, see testConfig), so the next two requests wait.
    await ask("tok_owner1", "owner1-lease");
    await ask("tok_owner2", "owner2-lease");
    void ask("tok_owner1", "owner1-waiting").catch(() => undefined);
    void ask("host", "agent-7").catch(() => undefined);
    await expect.poll(() => engine.queueDepth).toBe(2);

    const cases = [
      [
        "admin",
        { principal: "tok_admin", role: "admin" },
        ["owner1-lease", "owner2-lease"],
        ["owner1-waiting", "agent-7"],
      ],
      [
        "an agent with a lease and a waiting request",
        { principal: "tok_owner1", role: "agent" },
        ["owner1-lease"],
        ["owner1-waiting"],
      ],
      [
        "an agent whose request waits under another requesterId",
        { principal: "host", role: "agent" },
        [],
        ["agent-7"],
      ],
      ["an agent that owns nothing", { principal: "tok_nobody", role: "agent" }, [], []],
    ] as const;
    const seen = await Promise.all(
      cases.map(async ([name, who]) => {
        const status = await dispatcher.dispatch("status.get", {}, session(who));
        return {
          leases: status.leases?.map((lease) => lease.requesterId),
          name,
          waiting: status.waiting?.map((request) => request.requesterId),
        };
      }),
    );

    expect(seen).toEqual(cases.map(([name, , leases, waiting]) => ({ leases, name, waiting })));
  });

  it("lease.cancel: naming a requesterId with no pending request always passes (not-found), admin bypasses too", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });

    await expect(
      dispatcher.dispatch("lease.cancel", {}, session({ principal: "tok_agent", role: "agent" })),
    ).resolves.toMatchObject({ result: "not-found" });

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_admin", role: "admin" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });
  });

  it("lease.cancel: gated on the pending request's recorded owner (ADR §4), not the requesterId -- so a proxy connection can cancel what it created", async () => {
    const { dispatcher, engine } = await buildDispatcher();

    await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "tok_owner1",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "tok_owner1" }),
    );
    await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "tok_owner2",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "tok_owner2" }),
    );

    const queuedRequest = dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "agent-7",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "host" }),
    );
    await expect.poll(() => engine.queueDepth).toBe(1);

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "agent-7" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "agent-7" },
        session({ principal: "host", role: "agent" }),
      ),
    ).resolves.toMatchObject({ result: "cancelled" });

    const cancelled = await queuedRequest.then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect(cancelled).toBeInstanceOf(RequestCancelledError);
  });

  it("status.get: lists a waiting row only to the owner of that row's own request, with two owners using one requester label on different platforms", async () => {
    const clock = new FakeClock(1_000);
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const { dispatcher, registry } = await buildDispatcher({
      capacity: {
        strategy: "resource",
        config: {
          limits: {
            android: { maxDevices: 1, maxRunning: 1 },
            ios: { maxDevices: 1, maxRunning: 1 },
            maxRunning: 2,
          },
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
        },
      },
      clock,
      extraDrivers: [android],
      lease: { maxPerRequester: { ios: 1, android: 1 } },
    });
    const requests = {
      android: { model: "Pixel 8", osVersion: "36", platform: "android" },
      ios: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    } as const;
    for (const platform of ["ios", "android"] as const) {
      await dispatcher.dispatch(
        "lease.request",
        { ...requests[platform], requesterId: `holder-${platform}` },
        session({ principal: `holder-${platform}` }),
      );
    }
    const open = (platform: "ios" | "android") =>
      registry
        .leaseRequests()
        .filter((record) => record.state === "open" && record.request.platform === platform);
    for (const platform of ["ios", "android"] as const) {
      void dispatcher
        .dispatch(
          "lease.request",
          { ...requests[platform], requesterId: "x" },
          session({ principal: `owner-${platform}` }),
        )
        .catch(() => undefined);
      await expect.poll(() => open(platform)).toHaveLength(1);
    }

    const seen = await Promise.all(
      (["ios", "android"] as const).map(async (platform) => {
        const status = await dispatcher.dispatch(
          "status.get",
          {},
          session({ principal: `owner-${platform}`, role: "agent" }),
        );
        return { platform, waiting: status.waiting?.map((request) => request.spec.platform) };
      }),
    );

    expect(seen).toEqual([
      { platform: "ios", waiting: ["ios"] },
      { platform: "android", waiting: ["android"] },
    ]);
  });

  it("lease.cancel {platform}: cancels only the named platform's waiting request, and is gated on that request's owner", async () => {
    const clock = new FakeClock(1_000);
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const { dispatcher, engine, registry } = await buildDispatcher({
      capacity: {
        strategy: "resource",
        config: {
          limits: {
            android: { maxDevices: 1, maxRunning: 1 },
            ios: { maxDevices: 1, maxRunning: 1 },
            maxRunning: 2,
          },
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
        },
      },
      clock,
      extraDrivers: [android],
      lease: { maxPerRequester: { ios: 1, android: 1 } },
    });
    const iosRequest = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    const androidRequest = { model: "Pixel 8", osVersion: "36", platform: "android" } as const;
    await dispatcher.dispatch(
      "lease.request",
      { ...iosRequest, requesterId: "holder-ios" },
      session({ principal: "holder-ios" }),
    );
    await dispatcher.dispatch(
      "lease.request",
      { ...androidRequest, requesterId: "holder-android" },
      session({ principal: "holder-android" }),
    );
    const waiting = (platform: "ios" | "android") =>
      registry
        .leaseRequests()
        .filter((record) => record.state === "open" && record.request.platform === platform);
    const iosWaiting = dispatcher.dispatch(
      "lease.request",
      { ...iosRequest, requesterId: "agent-1" },
      session({ principal: "owner-ios" }),
    );
    await expect.poll(() => waiting("ios")).toHaveLength(1);
    const androidWaiting = dispatcher.dispatch(
      "lease.request",
      { ...androidRequest, requesterId: "agent-1" },
      session({ principal: "owner-android" }),
    );
    await expect.poll(() => waiting("android")).toHaveLength(1);

    // why: the iOS request is the earliest, so a hook that ignored the platform would name its owner.
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { platform: "android", requesterId: "agent-1" },
        session({ principal: "owner-ios", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { platform: "android", requesterId: "agent-1" },
        session({ principal: "owner-android", role: "agent" }),
      ),
    ).resolves.toEqual({ result: "cancelled" });

    await expect(androidWaiting).rejects.toBeInstanceOf(RequestCancelledError);
    expect(waiting("ios")).toHaveLength(1);
    expect(waiting("android")).toHaveLength(0);
    expect(engine.queueDepth).toBe(1);
    void iosWaiting.catch(() => undefined);
  });
});

describe("Dispatcher: lease.release-all", () => {
  it("rejects an agent session with FORBIDDEN, without releasing anything", async () => {
    const { dispatcher, registry } = await buildDispatcher();
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    await expect(
      dispatcher.dispatch("lease.release-all", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("admin releases every lease, regardless of owner, and reports every released id", async () => {
    const { dispatcher, eventBus, registry } = await buildDispatcher();
    const first = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner_1" }),
    );
    const second = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner_2" }),
    );
    expect(registry.snapshot.leases).toHaveLength(2);

    const result = await dispatcher.dispatch(
      "lease.release-all",
      {},
      session({ principal: "tok_admin", role: "admin" }),
    );

    expect(new Set(result.leaseIds)).toEqual(new Set([first.lease.id, second.lease.id]));
    expect(registry.snapshot.leases).toHaveLength(0);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.released")
        .map((event) => (event.payload as { reason: string }).reason),
    ).toEqual(["killed", "killed"]);
  });
});

function roomFor(devices: number): Config["capacity"] {
  return {
    config: {
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: devices, maxRunning: devices },
        maxRunning: devices + 1,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
    strategy: "resource",
  };
}

describe("Dispatcher: lease.release-run", () => {
  it("ends the leases of the run the caller holds, with reason explicit, and answers their ids", async () => {
    const { dispatcher, eventBus, registry } = await buildDispatcher({ capacity: roomFor(4) });
    const lease = async (principal: string, requesterId: string, runId: string) =>
      (
        await dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios", requesterId, runId },
          session({ principal }),
        )
      ).lease.id;
    const first = await lease("tok_ci", "job-a", "nightly-7");
    const second = await lease("tok_ci", "job-b", "nightly-7");
    const otherRun = await lease("tok_ci", "job-c", "nightly-8");

    const result = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );

    expect(new Set(result.leaseIds)).toEqual(new Set([first, second]));
    expect(result.requestIds).toEqual([]);
    expect(registry.snapshot.leases.map((held) => held.id)).toEqual([otherRun]);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.released")
        .map((event) => (event.payload as { reason: string }).reason),
    ).toEqual(["explicit", "explicit"]);
  });

  it("cancels the queued requests of the run the caller holds, rejects them cancelled and lists their ids", async () => {
    const { dispatcher, eventBus, engine, registry } = await buildDispatcher({
      capacity: roomFor(1),
    });
    const held = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios", runId: "nightly-8" },
      session({ principal: "tok_ci" }),
    );
    const queue = (principal: string, runId: string) =>
      dispatcher
        .dispatch(
          "lease.request",
          {
            model: "iPhone 17 Pro",
            osVersion: "26.5",
            platform: "ios",
            requesterId: `${principal}-${runId}`,
            runId,
          },
          session({ principal }),
        )
        .then(
          () => undefined,
          (rejected: unknown) => rejected,
        );
    const mine = queue("tok_ci", "nightly-7");
    await expect.poll(() => engine.queueDepth).toBe(1);
    const otherRun = queue("tok_ci", "nightly-9");
    await expect.poll(() => engine.queueDepth).toBe(2);
    const otherOwner = queue("tok_other", "nightly-7");
    await expect.poll(() => engine.queueDepth).toBe(3);
    const myRequestId = engine
      .waitingRequests()
      .find((request) => request.requesterId === "tok_ci-nightly-7")?.id;

    const result = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );

    expect(result).toEqual({ leaseIds: [], requestIds: [myRequestId] });
    expect(await mine).toBeInstanceOf(RequestCancelledError);
    expect(engine.queueDepth).toBe(2);
    expect(registry.snapshot.leases.map((lease) => lease.id)).toEqual([held.lease.id]);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload),
    ).toMatchObject([{ requestId: myRequestId, reason: "cancelled" }]);

    await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-9" },
      session({ principal: "tok_ci" }),
    );
    await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_other" }),
    );
    expect(await otherRun).toBeInstanceOf(RequestCancelledError);
    expect(await otherOwner).toBeInstanceOf(RequestCancelledError);
  });

  it("releases the caller's request of the run that is booting a virtual device the moment it is granted, and lists its id", async () => {
    const { dispatcher, driver, eventBus, engine, registry } = await buildDispatcher();
    driver.hangMakeReady();
    const booting = dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios", runId: "nightly-7" },
      session({ principal: "tok_ci" }),
    );
    await expect.poll(() => engine.waitingRequests()[0]?.stage).toBe("starting");
    const requestId = engine.waitingRequests()[0]?.id;

    const result = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci" }),
    );

    expect(result).toEqual({ leaseIds: [], requestIds: [requestId] });
    driver.releaseMakeReady();
    const granted = await booting;
    await expect.poll(() => registry.snapshot.leases).toEqual([]);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.released")
        .map((event) => event.payload),
    ).toMatchObject([{ leaseId: granted.lease.id, reason: "explicit" }]);
  });

  it("reaches only the caller's own leases for an agent and every owner's for an admin, answers empty lists when nothing matches, and refuses a bad run id", async () => {
    const { dispatcher, registry } = await buildDispatcher({ capacity: roomFor(4) });
    const lease = async (principal: string, requesterId: string, runId: string) =>
      (
        await dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios", requesterId, runId },
          session({ principal }),
        )
      ).lease.id;
    const mine = await lease("tok_ci", "job-a", "nightly-7");
    const keptOtherRun = await lease("tok_ci", "job-b", "nightly-8");
    const theirs = await lease("tok_other", "job-c", "nightly-7");

    const agent = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );
    expect(agent).toEqual({ leaseIds: [mine], requestIds: [] });
    expect(registry.snapshot.leases.map((held) => held.id).sort()).toEqual(
      [keptOtherRun, theirs].sort(),
    );

    const nothing = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_ci", role: "agent" }),
    );
    expect(nothing).toEqual({ leaseIds: [], requestIds: [] });

    const admin = await dispatcher.dispatch(
      "lease.release-run",
      { runId: "nightly-7" },
      session({ principal: "tok_admin", role: "admin" }),
    );
    expect(admin).toEqual({ leaseIds: [theirs], requestIds: [] });
    expect(registry.snapshot.leases.map((held) => held.id)).toEqual([keptOtherRun]);

    await expect(
      dispatcher.dispatch(
        "lease.release-run",
        { runId: "run 1" },
        session({ principal: "tok_ci" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
