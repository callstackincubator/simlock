import { describe, expect, it, vi } from "vitest";
import { capacityChangedPayload, FakeDriver } from "../core/testing.js";
import { type Config, type LatestPresence } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import type { DispatcherOptions } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import { BootTimeoutError, DriverCrashError, UnknownLeaseError } from "../core/index.js";
import { RequestCancelledError } from "../leasing/index.js";
import {
  HOST_SYSTEM,
  buildDispatcher,
  flush,
  gibibyte,
  seedSlimDevice,
  session,
} from "./test-dispatcher.js";

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

describe("Dispatcher: device mode on every surface", () => {
  const request = { model: "iPhone 17 Pro", platform: "ios" } as const;

  it.each([
    ["slim", "a slim boot", "slim"],
    ["full", "no mode", undefined],
  ] as const)(
    "a lease grant's device carries mode: %s when the driver reported %s",
    async (expected, _reported, driverMode) => {
      const { dispatcher } = await buildDispatcher({ driverOptions: { mode: driverMode } });

      const grant = await dispatcher.dispatch("lease.request", request, session());

      expect(grant.device.mode).toBe(expected);
    },
  );

  it("status.get reports the capacity figures the last capacity.changed carries", async () => {
    const { dispatcher, engine, eventBus } = await buildDispatcher();
    await engine.convergeRunningCapacity();
    await dispatcher.dispatch("lease.request", request, session());

    const status = await dispatcher.dispatch("status.get", {}, session());

    const last = eventBus
      .replay()
      .filter((event) => event.event === "capacity.changed")
      .at(-1);
    const capacity = status.capacity as NonNullable<typeof status.capacity>;
    expect(last?.payload).toEqual(capacityChangedPayload(capacity));
    expect(status.capacity?.ios).toMatchObject({ running: 1, warm: 0, used: 1 });
  });

  it("lease.request grants a physical device with physical true and its class on the device", async () => {
    const { dispatcher, driver, engine } = await buildDispatcher({
      physicalDevices: [
        {
          backend: "local",
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          spec: {
            class: "tablet",
            model: "iPad Pro",
            osVersion: "18.4",
          },
          state: "ready",
        },
      ],
    });
    await engine.convergeRunningCapacity();
    driver.setPhysicalPresence("00008110-001A2B3C4D5E", true);

    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPad Pro", physical: true, platform: "ios" },
      session(),
    );

    expect(grant.device).toMatchObject({ class: "tablet", id: "dev_phys", physical: true });
  });

  it("status.get and list.get show a physical record with physical, its class and no mode or enrolledApps, and count nothing of it in the capacity figures", async () => {
    const { dispatcher, engine } = await buildDispatcher({
      physicalDevices: [
        {
          backend: "local",
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: ["com.example.kept"],
          id: "dev_phys",
          spec: {
            class: "tablet",
            model: "iPad Pro",
            osVersion: "18.4",
          },
          state: "ready",
        },
      ],
    });
    await engine.convergeRunningCapacity();
    const lease = await dispatcher.dispatch("lease.request", request, session());

    const status = await dispatcher.dispatch("status.get", {}, session());
    const listed = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; class?: string; mode?: string; physical: boolean }[];

    for (const devices of [status.devices ?? [], listed]) {
      const phys = devices.find((device) => device.id === "dev_phys");
      expect(phys).toMatchObject({ class: "tablet", physical: true, state: "ready" });
      expect(phys).not.toHaveProperty("mode");
      expect(phys).not.toHaveProperty("enrolledApps");
      const simulator = devices.find((device) => device.id === lease.device.id);
      expect(simulator).toMatchObject({ mode: "full", physical: false });
      expect(simulator).not.toHaveProperty("class");
    }
    expect(status.capacity?.ios).toMatchObject({ running: 1, used: 1, warm: 0 });
  });

  it("status.get and list.get carry the latest presence read as presence on a physical device; a virtual device, and a physical device not yet read, carry none", async () => {
    const physical = (id: string, driverDeviceId: string) => ({
      backend: "local",
      createdAt: 1,
      driverDeviceId,
      enrolledApps: [],
      id,
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state: "ready",
    });
    const reads = new Map<string, LatestPresence>([
      ["UDID-READ", { present: false, reason: "locked" }],
      ["UDID-PRESENT", { present: true }],
    ]);
    const { dispatcher, engine } = await buildDispatcher({
      // why: every ID but the unread one answers a read, so a virtual device's own driver ID does too and only the physical guard keeps it off the wire.
      presence: (driverDeviceId) =>
        driverDeviceId === "UDID-UNREAD"
          ? undefined
          : (reads.get(driverDeviceId) ?? { present: true }),
      physicalDevices: [
        physical("dev_read", "UDID-READ"),
        physical("dev_present", "UDID-PRESENT"),
        physical("dev_unread", "UDID-UNREAD"),
      ],
    });
    await engine.convergeRunningCapacity();
    const lease = await dispatcher.dispatch("lease.request", request, session());

    const status = await dispatcher.dispatch("status.get", {}, session());
    const listed = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; presence?: unknown }[];

    for (const devices of [status.devices ?? [], listed]) {
      const byId = (id: string) => devices.find((device) => device.id === id);
      expect(byId("dev_read")).toMatchObject({ presence: { present: false, reason: "locked" } });
      expect(byId("dev_present")).toMatchObject({ presence: { present: true } });
      expect(byId("dev_unread")).not.toHaveProperty("presence");
      expect(byId(lease.device.id)).not.toHaveProperty("presence");
    }
  });

  it("a reclaiming physical device's status entry has no reclaimingSince", async () => {
    const { dispatcher } = await buildDispatcher({
      physicalDevices: [
        {
          backend: "local",
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          lastLeaseEndedAt: 200,
          reclaimingSince: 600,
          spec: {
            class: "phone",
            model: "iPhone 15 Pro",
            osVersion: "18.4",
          },
          state: "reclaiming",
        },
      ],
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    const entry = status.devices?.find((device) => device.id === "dev_phys");
    expect(entry).toMatchObject({ state: "reclaiming", transitionAgeMs: 400 });
    expect(entry).not.toHaveProperty("reclaimingSince");
  });

  it("status.get carries the warm pool's figures: the reserve, and a target the pass could not meet with its reason", async () => {
    const { dispatcher, engine } = await buildDispatcher({
      warmPool: {
        reserveRunning: { android: 0, ios: 1 },
        targets: [{ count: 1, model: "iPhone 17", osVersion: "27.0", platform: "ios" }],
      },
    });
    await engine.convergeRunningCapacity();
    await engine.core.passWarmPool();

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.warmPool).toStrictEqual({
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [
        {
          booting: 0,
          count: 1,
          mode: "full",
          model: "iPhone 17",
          origin: "configured",
          osVersion: "27.0",
          platform: "ios",
          ready: 0,
          short: "runtime-missing",
        },
      ],
    });
  });

  it("status.get on a daemon whose pool is off carries enabled false, the reserve and every configured target with ready 0, booting 0 and short disabled", async () => {
    const { dispatcher } = await buildDispatcher({
      warmPool: {
        enabled: false,
        reserveRunning: { android: 1, ios: 0 },
        targets: [
          { count: 2, model: "iPhone 17", osVersion: "26.5", platform: "ios" },
          { count: 1, mode: "slim", model: "Pixel 8", platform: "android" },
        ],
      },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.warmPool).toStrictEqual({
      enabled: false,
      reserveRunning: { android: 1, ios: 0 },
      targets: [
        {
          booting: 0,
          count: 2,
          mode: "full",
          model: "iPhone 17",
          origin: "configured",
          osVersion: "26.5",
          platform: "ios",
          ready: 0,
          short: "disabled",
        },
        {
          booting: 0,
          count: 1,
          mode: "slim",
          model: "Pixel 8",
          origin: "configured",
          platform: "android",
          ready: 0,
          short: "disabled",
        },
      ],
    });
  });

  it("status.get and list.get return mode for every device, including one still provisioning", async () => {
    const { dispatcher, registry } = await buildDispatcher({ driverOptions: { mode: "slim" } });
    const granted = await dispatcher.dispatch("lease.request", request, session());
    const provisioning = await registry.registerDevice({
      backend: "local",
      driverData: { fakeDeviceId: "driver-provisioning" },
      driverDeviceId: "driver-provisioning",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    );

    const expected = [
      { id: granted.device.id, mode: "slim" },
      { id: provisioning.id, mode: "full" },
    ];
    expect(status.devices?.map(({ id, mode }) => ({ id, mode }))).toEqual(expected);
    expect((list as { id: string; mode: string }[]).map(({ id, mode }) => ({ id, mode }))).toEqual(
      expected,
    );
  });

  it.each([
    ["slim", true, false],
    ["full", false, true],
  ] as const)(
    "status.get and list.get report servesDefaultMode for every device: on a worker whose default is %s, a slim pool is %s and a full pool is %s",
    async (defaultMode, slimServes, fullServes) => {
      const { dispatcher, registry } = await buildDispatcher({
        engine: { defaultModes: { ios: defaultMode } },
      });
      const register = (driverDeviceId: string, slim: boolean) =>
        registry.registerDevice({
          backend: "local",
          driverData: { fakeDeviceId: driverDeviceId },
          driverDeviceId,
          provisionDuration: 0,
          spec: {
            physical: false,
            model: "iPhone 17 Pro",
            osVersion: "26.5",
            platform: "ios",
            ...(slim ? { mode: "slim" as const } : {}),
          },
        });
      const slim = await register("driver-slim", true);
      const full = await register("driver-full", false);

      const status = await dispatcher.dispatch("status.get", {}, session());
      const list = await dispatcher.dispatch(
        "list.get",
        { kind: "devices" },
        session({ role: "admin" }),
      );

      const expected = [
        { id: slim.id, servesDefaultMode: slimServes },
        { id: full.id, servesDefaultMode: fullServes },
      ];
      const project = (devices: readonly { id: string; servesDefaultMode?: boolean }[]) =>
        devices.map(({ id, servesDefaultMode }) => ({ id, servesDefaultMode }));
      expect(project(status.devices ?? [])).toEqual(expected);
      expect(project(list as { id: string; servesDefaultMode?: boolean }[])).toEqual(expected);
    },
  );

  it("status marks a stalled device with stalled: true and leaves others without it", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher();
    const leased = await dispatcher.dispatch("lease.request", request, session());
    const register = (driverDeviceId: string) =>
      registry.registerDevice({
        backend: "local",
        driverData: { fakeDeviceId: driverDeviceId },
        driverDeviceId,
        provisionDuration: 0,
        spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      });
    const stuck = await register("driver-stuck");
    clock.advance(60_001);
    const fresh = await register("driver-fresh");

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; stalled?: boolean }[];
    const { workers } = await dispatcher.dispatch(
      "worker.list",
      {},
      session({ principal: "operator", role: "admin" }),
    );

    for (const devices of [status.devices, list, workers[0]?.devices ?? []]) {
      const byId = new Map(devices?.map((device) => [device.id, device]));
      expect(byId.get(stuck.id)?.stalled).toBe(true);
      expect(byId.get(fresh.id)).toBeDefined();
      expect(byId.get(fresh.id)).not.toHaveProperty("stalled");
      expect(byId.get(leased.device.id)).toBeDefined();
      expect(byId.get(leased.device.id)).not.toHaveProperty("stalled");
    }
  });

  it("status leaves stalled off a device past its threshold that a live operation holds", async () => {
    const claimed = new Set<string>();
    const { clock, dispatcher, registry } = await buildDispatcher({
      claims: { isClaimed: (deviceId) => claimed.has(deviceId) },
    });
    const device = await registry.registerDevice({
      backend: "local",
      driverData: { fakeDeviceId: "driver-booting" },
      driverDeviceId: "driver-booting",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });
    clock.advance(60_001);
    const stalled = async () =>
      (await dispatcher.dispatch("status.get", {}, session())).devices?.find(
        (entry) => entry.id === device.id,
      )?.stalled;

    claimed.add(device.id);
    expect(await stalled()).toBeUndefined();
    claimed.delete(device.id);
    expect(await stalled()).toBe(true);
  });

  it("status measures a stall against the driver for the device's own platform", async () => {
    const android = new FakeDriver({
      clock: new FakeClock(1_000),
      estimateMs: { boot: 300_000, provision: 300_000 },
      platform: "android",
    });
    const { clock, dispatcher, registry } = await buildDispatcher({ otherStallDrivers: [android] });
    const device = await registry.registerDevice({
      backend: "local",
      driverData: { fakeDeviceId: "driver-ios-stuck" },
      driverDeviceId: "driver-ios-stuck",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });
    clock.advance(60_001);

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.devices?.find((entry) => entry.id === device.id)?.stalled).toBe(true);
  });

  it("no lease.request, list.get, or status.get response carries featureProfile or slim", async () => {
    const { dispatcher } = await buildDispatcher({ driverOptions: { mode: "slim" } });

    const responses = [
      await dispatcher.dispatch("lease.request", request, session()),
      await dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
      await dispatcher.dispatch("status.get", {}, session()),
    ];

    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).toContain('"mode":"slim"');
      expect(json).not.toContain('"featureProfile"');
      expect(json).not.toContain('"slim":');
    }
  });
});

describe("Dispatcher: a noWait lease.request refused for capacity names the check that refused it", () => {
  const sizes = { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte };
  const limits = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 4, maxRunning: 4 },
    maxRunning: 6,
  };
  const ios = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
  const resource = (
    overrides: { limits?: typeof limits; ramBudget?: typeof sizes } = {},
  ): Config["capacity"] => ({
    strategy: "resource",
    config: { limits: overrides.limits ?? limits, ramBudget: overrides.ramBudget ?? sizes },
  });
  const holder = () => session({ principal: "tok_holder" });
  const asker = () => session({ principal: "tok_asker" });
  const refusal = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error("expected the request to be refused");
      },
      (error: unknown) => error,
    );

  it.each([
    {
      name: "the RAM budget",
      reason: "ram-budget",
      capacity: resource({ ramBudget: { ...sizes, iosBytesPerDevice: 30 * gibibyte } }),
      holds: false,
    },
    {
      name: "the device limit",
      reason: "device-limit",
      capacity: resource({ limits: { ...limits, ios: { maxDevices: 1, maxRunning: 4 } } }),
      holds: true,
    },
    {
      name: "the platform running limit",
      reason: "platform-running-limit",
      capacity: resource({ limits: { ...limits, ios: { maxDevices: 4, maxRunning: 1 } } }),
      holds: true,
    },
  ] as const)("rejects NO_CAPACITY with details.capacityReason $reason at $name", async (row) => {
    const { dispatcher } = await buildDispatcher({ capacity: row.capacity });
    if (row.holds) await dispatcher.dispatch("lease.request", ios, holder());

    await expect(
      dispatcher.dispatch("lease.request", { ...ios, noWait: true }, asker()),
    ).rejects.toMatchObject({ code: "NO_CAPACITY", details: { capacityReason: row.reason } });
  });

  it("rejects NO_CAPACITY with no details for a request behind an earlier one", async () => {
    const { dispatcher } = await buildDispatcher({
      capacity: resource({ limits: { ...limits, ios: { maxDevices: 1, maxRunning: 4 } } }),
    });
    await dispatcher.dispatch("lease.request", ios, holder());
    const waiting = dispatcher.dispatch("lease.request", ios, session({ principal: "tok_head" }));
    void waiting.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const error = await refusal(
      dispatcher.dispatch("lease.request", { ...ios, noWait: true }, asker()),
    );

    expect(classifyError(error)).toBe("NO_CAPACITY");
    expect((error as { details?: unknown }).details).toBeUndefined();
  });

  it("answers a replay of the RAM-budget request by its idempotency key with NO_CAPACITY and no details", async () => {
    const { dispatcher } = await buildDispatcher({
      capacity: resource({ ramBudget: { ...sizes, iosBytesPerDevice: 30 * gibibyte } }),
    });
    const input = { ...ios, idempotencyKey: "key-1", noWait: true } as const;
    await expect(dispatcher.dispatch("lease.request", input, asker())).rejects.toMatchObject({
      details: { capacityReason: "ram-budget" },
    });

    const replay = await refusal(dispatcher.dispatch("lease.request", input, asker()));

    expect(classifyError(replay)).toBe("NO_CAPACITY");
    expect((replay as { details?: unknown }).details).toBeUndefined();
  });
});

describe("Dispatcher: startup-readiness parking", () => {
  it("answers status.get with host facts while other operations are parked on startup", async () => {
    const { dispatcher } = await buildDispatcher({
      awaitReady: () => new Promise<void>(() => undefined),
      hostFacts: () => ({
        ...HOST_SYSTEM,
        tools: [{ name: "xcode", platform: "ios", version: "16.4" }],
      }),
    });

    let parked = true;
    void dispatcher.dispatch("catalog.get", {}, session()).then(() => {
      parked = false;
    });
    const status = (await dispatcher.dispatch("status.get", {}, session())) as {
      readonly host: { readonly os: string; readonly tools: readonly unknown[] };
    };
    await flush();

    expect(parked).toBe(true);
    expect(status.host.os).toBe("macOS");
    expect(status.host.tools).toHaveLength(1);
  });

  it("parks every operation but status.get on awaitReady", async () => {
    let releaseReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { dispatcher } = await buildDispatcher({ awaitReady: () => readyPromise });

    let statusSettled = false;
    void dispatcher.dispatch("status.get", {}, session()).then(() => {
      statusSettled = true;
    });
    await flush();
    expect(statusSettled).toBe(true);

    const parked = {
      "catalog.get": dispatcher.dispatch("catalog.get", {}, session()),
      "lease.request": dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      ),
      "list.get": dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
    };
    const settled = new Set<string>();
    for (const [operation, answer] of Object.entries(parked)) {
      void answer.then(
        () => settled.add(operation),
        () => settled.add(operation),
      );
    }
    await flush();
    expect([...settled]).toEqual([]);

    releaseReady();
    await flush();
    expect([...settled].sort()).toEqual(["catalog.get", "lease.request", "list.get"]);
  });
});

describe("Dispatcher: lease.request requires", () => {
  const IOS = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
  const REQUIRES = { ...IOS, requires: ["agent-device"] } as const;
  type SourceState = { state: "available" | "off" | "unavailable" };

  function sources(initial: SourceState["state"]) {
    const current: SourceState = { state: initial };
    return {
      current,
      list: [{ name: "agent-device", read: async () => ({ state: current.state }) }] as NonNullable<
        DispatcherOptions["capabilitySources"]
      >,
    };
  }

  it("refuses a request on a worker whose agent-device is off with CAPABILITY_MISSING, message `This worker cannot serve agent-device`, details naming it, stores nothing and emits no event", async () => {
    const capability = sources("available");
    const { dispatcher, eventBus, registry } = await buildDispatcher({
      capabilitySources: capability.list,
    });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { ...REQUIRES, requesterId: "a" },
      session(),
    );
    await dispatcher.dispatch("lease.release", { leaseId: grant.lease.id }, session());
    // why: the release deletes the device in the background; its event must land before the baseline.
    await vi.waitFor(() =>
      expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["deleted"]),
    );
    capability.current.state = "off";
    const requestsBefore = registry.leaseRequests().length;
    const eventsBefore = eventBus.replay().length;

    await expect(
      dispatcher.dispatch("lease.request", { ...REQUIRES, requesterId: "b" }, session()),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      message: "This worker cannot serve agent-device",
    });

    expect(registry.leaseRequests()).toHaveLength(requestsBefore);
    expect(eventBus.replay()).toHaveLength(eventsBefore);
  });

  it("refuses the same request from the gateway uplink as a probe, the same way, with no lease.declined", async () => {
    const capability = sources("unavailable");
    const { dispatcher, eventBus, registry } = await buildDispatcher({
      capabilitySources: capability.list,
    });

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...REQUIRES, fleetRequestId: "req_gw1", noWait: true },
        session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      message: "This worker cannot serve agent-device",
    });

    expect(registry.leaseRequests()).toEqual([]);
    expect(eventBus.replay().map((event) => event.event)).not.toContain("lease.declined");
  });

  it("names only x-other when requires is [x-other, agent-device] and only agent-device is available", async () => {
    const { dispatcher } = await buildDispatcher({
      capabilitySources: sources("available").list,
    });

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...IOS, requires: ["x-other", "agent-device"] },
        session(),
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["x-other"] },
      message: "This worker cannot serve x-other",
    });
  });

  it("refuses within 1.5 s with CAPABILITY_MISSING when the capability source takes 2 s", async () => {
    const clock = new FakeClock(1_000);
    const { dispatcher } = await buildDispatcher({
      capabilitySources: [
        {
          name: "agent-device",
          read: () =>
            new Promise((resolve) => clock.setTimer(2_000, () => resolve({ state: "available" }))),
        },
      ],
      clock,
    });
    let settled = false;
    const answer = dispatcher.dispatch("lease.request", REQUIRES, session()).then(
      () => "granted",
      (error: unknown) => error,
    );
    void answer.then(() => {
      settled = true;
    });

    for (let elapsed = 0; elapsed < 1_500; elapsed += 100) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(100);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(true);
    expect(await answer).toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("grants a queued request with requires once a device frees, even though the capability turned unavailable while it waited", async () => {
    const capability = sources("available");
    const { dispatcher, engine } = await buildDispatcher({ capabilitySources: capability.list });
    const first = await dispatcher.dispatch(
      "lease.request",
      { ...IOS, requesterId: "h1" },
      session(),
    );
    await dispatcher.dispatch("lease.request", { ...IOS, requesterId: "h2" }, session());
    const waiting = dispatcher.dispatch(
      "lease.request",
      { ...REQUIRES, requesterId: "w" },
      session(),
    );
    await expect.poll(() => engine.queueDepth).toBe(1);
    capability.current.state = "unavailable";

    await dispatcher.dispatch("lease.release", { leaseId: first.lease.id }, session());

    await expect(waiting).resolves.toMatchObject({ lease: { requesterId: "w" } });
  });

  it("refuses requires together with idempotencyKey with BAD_REQUEST and stores nothing", async () => {
    const { dispatcher, registry } = await buildDispatcher({
      capabilitySources: sources("available").list,
    });

    await expect(
      dispatcher.dispatch("lease.request", { ...REQUIRES, idempotencyKey: "key-1" }, session()),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("requires cannot be combined with idempotencyKey"),
    });

    expect(registry.leaseRequests()).toEqual([]);
    expect(registry.snapshot.leases).toEqual([]);
  });

  it.each([
    ["absent", {}],
    ["[]", { requires: [] }],
  ])(
    "a request with requires %s is granted on a worker whose agent-device is off, and lease.requested's requestSpec has no requires",
    async (_label, extra) => {
      const { dispatcher, eventBus } = await buildDispatcher({
        capabilitySources: sources("off").list,
      });

      await dispatcher.dispatch("lease.request", { ...IOS, ...extra }, session());

      const requested = eventBus.replay().find((event) => event.event === "lease.requested");
      expect(requested?.payload).toMatchObject({ requestSpec: IOS });
      expect(JSON.stringify(requested?.payload)).not.toContain("requires");
    },
  );

  it("a request with requires is granted as today on a worker with the capability, and its requestSpec has no requires", async () => {
    const { dispatcher, eventBus } = await buildDispatcher({
      capabilitySources: sources("available").list,
    });

    const grant = await dispatcher.dispatch("lease.request", REQUIRES, session());

    expect(grant.device.spec).toMatchObject({ model: "iPhone 17 Pro", platform: "ios" });
    const requested = eventBus.replay().find((event) => event.event === "lease.requested");
    expect(requested?.payload).toMatchObject({ requestSpec: IOS });
    expect(JSON.stringify(requested?.payload)).not.toContain("requires");
  });
});

describe("Dispatcher: lease.request at new-devices-paused", () => {
  const slimmable = { slimmableOsVersions: ["26.5"] };
  const ask = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
  const slim = { ...ask, mode: "slim" } as const;
  const asker = () => session({ principal: "tok_asker" });
  const waiting = (built: Awaited<ReturnType<typeof buildDispatcher>>) =>
    built.dispatcher.dispatch("list.get", { kind: "requests" }, session({ role: "admin" }));
  const fixed: Config["capacity"] = { strategy: "fixed", config: { maxRunning: 4 } };

  it.each([
    { name: "needs a new device", seed: undefined, input: ask, options: {} },
    { name: "boots a shut-down device", seed: "shutdown", input: slim, options: {} },
    {
      name: "needs the reboot of an idle device for its except list",
      seed: "ready",
      input: { ...slim, except: ["store"] },
      options: {},
    },
    {
      name: "is refused for RAM too",
      seed: undefined,
      input: ask,
      options: {
        capacity: {
          strategy: "resource",
          config: {
            limits: {
              android: { maxDevices: 1, maxRunning: 1 },
              ios: { maxDevices: 4, maxRunning: 4 },
              maxRunning: 6,
            },
            ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 30 * gibibyte },
          },
        },
      },
    },
    {
      name: "runs under the fixed strategy",
      seed: undefined,
      input: ask,
      options: { capacity: fixed },
    },
  ] as const)(
    "a request that $name waits, or gets NO_CAPACITY under noWait, with memory-pressure",
    async (row) => {
      const start = async () => {
        const built = await buildDispatcher({
          driverOptions: slimmable,
          memoryPressureStep: "new-devices-paused",
          ...row.options,
        });
        if (row.seed !== undefined) await seedSlimDevice(built, row.seed);
        return { built, seededCalls: built.driver.calls.length };
      };
      const driven = (world: Awaited<ReturnType<typeof start>>) =>
        world.built.driver.calls
          .slice(world.seededCalls)
          .filter((call) => ["provision", "makeReady", "shutdown"].includes(call.operation));

      const waiter = await start();
      void waiter.built.dispatcher
        .dispatch("lease.request", row.input, asker())
        .catch(() => undefined);
      await flush();
      const listed = await waiting(waiter.built);
      const refused = await start();

      await expect(
        refused.built.dispatcher.dispatch("lease.request", { ...row.input, noWait: true }, asker()),
      ).rejects.toMatchObject({
        code: "NO_CAPACITY",
        details: { capacityReason: "memory-pressure" },
      });
      expect(listed).toMatchObject([{ reason: "memory-pressure", stage: "queued" }]);
      expect(driven(waiter)).toEqual([]);
      expect(driven(refused)).toEqual([]);
    },
  );

  it("grants a request that fits an idle booted device, and does not evict an idle device of another kind", async () => {
    const granted = await buildDispatcher({
      driverOptions: slimmable,
      memoryPressureStep: "new-devices-paused",
    });
    const registered = await seedSlimDevice(granted, "ready");
    await expect(
      granted.dispatcher.dispatch("lease.request", slim, asker()),
    ).resolves.toMatchObject({ device: { id: registered.id } });

    const limited = await buildDispatcher({
      capacity: {
        strategy: "resource",
        config: {
          limits: {
            android: { maxDevices: 1, maxRunning: 1 },
            ios: { maxDevices: 4, maxRunning: 1 },
            maxRunning: 6,
          },
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
        },
      },
      driverOptions: slimmable,
      memoryPressureStep: "new-devices-paused",
    });
    const idle = await seedSlimDevice(limited, "ready");
    await expect(
      limited.dispatcher.dispatch("lease.request", { ...ask, mode: "full", noWait: true }, asker()),
    ).rejects.toMatchObject({ details: { capacityReason: "memory-pressure" } });
    expect(limited.registry.snapshot.virtualDevices.find((d) => d.id === idle.id)?.state).toBe(
      "ready",
    );
  });

  it.each(["none", "warming-paused"] as const)(
    "a request waiting on memory pressure reads memory-pressure, then is served when the step lifts to %s with no other event",
    async (lifted) => {
      const built = await buildDispatcher({ memoryPressureStep: "new-devices-paused" });
      let granted: unknown;
      void built.dispatcher.dispatch("lease.request", ask, asker()).then((grant) => {
        granted = grant;
      });
      await flush();
      const before = await waiting(built);

      built.setMemoryPressure(lifted);
      built.eventBus.emit(
        "memory.pressure-changed",
        { from: "new-devices-paused", to: lifted },
        "test",
      );

      await flush();

      expect(before).toMatchObject([{ reason: "memory-pressure" }]);
      expect(granted).toMatchObject({ lease: { ownerId: "tok_asker" } });
    },
  );
});

describe("Dispatcher: lease.request whose device fails to boot", () => {
  it("answers a boot timeout or failed boot of a new or shut-down device as PROVISION_FAILED with the boot's message", async () => {
    const ask = {
      mode: "slim",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const timedOut = /^Timed out waiting for device to boot: /;
    const failed = /^Device failed to boot: .+: simulator exited$/;
    const cases = [
      ["a new device", new BootTimeoutError("sim-1"), timedOut],
      ["a new device", new DriverCrashError("simulator exited"), failed],
      ["a shut-down device", new BootTimeoutError("sim-1"), timedOut],
      ["a shut-down device", new DriverCrashError("simulator exited"), failed],
    ] as const;

    for (const [target, error, message] of cases) {
      const name = `${target}: ${error.name}`;
      const built = await buildDispatcher({ driverOptions: { slimmableOsVersions: ["26.5"] } });
      if (target === "a shut-down device") {
        await seedSlimDevice(built, "shutdown");
        // why: call 1 of makeReady is the seed's own boot; the waiter's boot is call 2.
        built.driver.failOn("makeReady", 2, error);
      } else {
        built.driver.failOn("makeReady", 1, error);
      }

      const refusal = await built.dispatcher
        .dispatch("lease.request", ask, session())
        .catch((caught: unknown) => caught);

      expect(
        built.eventBus.replay().find((event) => event.event === "lease.rejected")?.payload,
        name,
      ).toMatchObject({ reason: "boot-timeout" });
      expect(classifyError(refusal) ?? "INTERNAL", name).toBe("PROVISION_FAILED");
      expect((refusal as Error).message, name).toMatch(message);
    }
  });
});
