import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { request, androidRequest, createHarness, settledOrPending } from "./test-create-leasing.js";

describe("createLeasing: a requester may hold up to lease.maxPerRequester leases (ADR 0023)", () => {
  const roomy = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 4, maxRunning: 4 },
    maxRunning: 5,
  };
  const twoDevices = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 2, maxRunning: 2 },
    maxRunning: 3,
  };
  const asking = (requesterId: string, more: Record<string, unknown> = {}) => ({
    ownerId: requesterId,
    requesterId,
    ...more,
  });
  const atLimit = (held: number, limit: number, leaseId: string) =>
    `Requester agent-1 already holds ${String(held)} leases and lease.maxPerRequester is ${String(limit)}; release one (\`simlock release ${leaseId}\`) before requesting another device`;
  const waitingMessage =
    "Requester agent-1 already has a waiting request; wait for it to be granted or cancel it before requesting another device";

  it("with no lease.maxPerRequester, a requester holding a lease is refused with today's message, naming that lease, and is granted another once it releases it", async () => {
    const harness = await createHarness({ limits: roomy });
    const first = await harness.engine.request(request, asking("agent-1"));

    const refusal = await harness.engine
      .request(request, asking("agent-1"))
      .catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: first.lease.id,
      message: `Requester agent-1 already holds lease ${first.lease.id}; release it (\`simlock release ${first.lease.id}\`) before requesting another device`,
      name: "RequesterAlreadyLeasedError",
    });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    await expect(harness.engine.request(request, asking("agent-1"))).resolves.toMatchObject({
      lease: { ownerId: "agent-1", requesterId: "agent-1" },
    });
  });

  it("with no lease.maxPerRequester, a requester with a waiting request is refused with today's message", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, asking("holder"));
    void harness.engine.request(request, asking("agent-1")).catch(() => undefined);
    await expect
      .poll(() =>
        harness.registry.leaseRequests().find((record) => record.requesterId === "agent-1"),
      )
      .toMatchObject({ state: "open" });

    const refusal = await harness.engine
      .request(request, asking("agent-1"))
      .catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: "Requester already has a lease or pending request: agent-1",
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with lease.maxPerRequester: 2, one requester holds two leases at once", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });

    const first = await harness.engine.request(request, asking("agent-1"));
    const second = await harness.engine.request(request, asking("agent-1"));

    expect(second.lease.id).not.toBe(first.lease.id);
    expect(
      harness.registry.snapshot.leases.filter((lease) => lease.requesterId === "agent-1"),
    ).toHaveLength(2);
  });

  it("with lease.maxPerRequester: 2, a requester holding two leases is refused, the message naming the limit and the earlier-granted lease", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });
    await harness.engine.request(request, asking("agent-1", { leaseId: "zeta" }));
    harness.clock.advance(5);
    await harness.engine.request(request, asking("agent-1", { leaseId: "alpha" }));

    const refusal = await harness.engine
      .request(request, asking("agent-1"))
      .catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "zeta",
      message: atLimit(2, 2, "zeta"),
      name: "RequesterAlreadyLeasedError",
      requesterId: "agent-1",
    });
  });

  it("with lease.maxPerRequester: 3, a requester holding one lease and one waiting request is refused with the waiting-request message", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 3 }, limits: twoDevices });
    await harness.engine.request(request, asking("agent-1"));
    await harness.engine.request(request, asking("other"));
    void harness.engine.request(request, asking("agent-1")).catch(() => undefined);
    await expect
      .poll(() =>
        harness.registry
          .leaseRequests()
          .filter((record) => record.requesterId === "agent-1" && record.state === "open"),
      )
      .toHaveLength(1);

    const refusal = await harness.engine
      .request(request, asking("agent-1"))
      .catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with lease.maxPerRequester per platform, a requester holding an iOS lease is granted an Android one", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      lease: { maxPerRequester: { ios: 1, android: 1 } },
      limits: roomy,
    });
    const first = await harness.engine.request(request, asking("agent-1"));

    const second = await harness.engine.request(androidRequest, asking("agent-1"));

    expect(first.device.spec.platform).toBe("ios");
    expect(second.device.spec.platform).toBe("android");
  });

  it.each([
    {
      name: "limit 1 on iOS",
      limit: { ios: 1, android: 1 },
      held: [request],
      next: request,
      message: (ids: string[]) =>
        `Requester agent-1 already holds iOS lease ${ids[0]}; release it (\`simlock release ${ids[0]}\`) before requesting another iOS device`,
    },
    {
      name: "an Android platform the object leaves out, so its limit is 1",
      limit: { ios: 2 },
      held: [androidRequest],
      next: androidRequest,
      message: (ids: string[]) =>
        `Requester agent-1 already holds Android lease ${ids[0]}; release it (\`simlock release ${ids[0]}\`) before requesting another Android device`,
    },
    {
      name: "two iOS leases at an iOS limit of 2",
      limit: { ios: 2, android: 1 },
      held: [request, request],
      next: request,
      message: (ids: string[]) =>
        `Requester agent-1 already holds 2 iOS leases and lease.maxPerRequester.ios is 2; release one (\`simlock release ${ids[0]}\`) before requesting another iOS device`,
    },
  ])(
    "with lease.maxPerRequester per platform, a requester at its limit on a platform is refused with that platform's message naming its earliest lease ($name)",
    async ({ limit, held, next, message }) => {
      const clock = new FakeClock(1_000);
      const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
      const harness = await createHarness({
        driver: ios,
        drivers: [ios, android],
        lease: { maxPerRequester: limit },
        limits: roomy,
      });
      const ids: string[] = [];
      for (const spec of held) {
        const grant = await harness.engine.request(spec, asking("agent-1"));
        ids.push(grant.lease.id);
        harness.clock.advance(5);
      }

      const refusal = await harness.engine
        .request(next, asking("agent-1"))
        .catch((e: unknown) => e);

      expect(refusal).toMatchObject({
        existingLeaseId: ids[0],
        message: message(ids),
        name: "RequesterAlreadyLeasedError",
      });
    },
  );

  it.each([
    {
      name: "an Android request while an iOS one waits is admitted",
      limit: { ios: 1, android: 1 },
      iosDevices: 1,
      next: androidRequest,
      refusal: undefined,
    },
    {
      name: "an iOS request while an iOS one waits is refused",
      limit: { ios: 1, android: 1 },
      iosDevices: 1,
      next: request,
      refusal:
        "Requester agent-1 already has a waiting iOS request; wait for it to be granted or cancel it before requesting another iOS device",
    },
    {
      name: "an iOS request holding one iOS lease and waiting for another under an iOS limit of 2 is refused",
      limit: { ios: 2 },
      iosDevices: 2,
      next: request,
      holdsIos: true,
      refusal:
        "Requester agent-1 already has a waiting iOS request; wait for it to be granted or cancel it before requesting another iOS device",
    },
  ])(
    "with lease.maxPerRequester per platform, a requester with a waiting request is refused another on that platform only ($name)",
    async ({ limit, iosDevices, next, refusal, holdsIos }) => {
      const clock = new FakeClock(1_000);
      const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
      const harness = await createHarness({
        driver: ios,
        drivers: [ios, android],
        lease: { maxPerRequester: limit },
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: iosDevices, maxRunning: iosDevices },
          maxRunning: iosDevices + 1,
        },
      });
      await harness.engine.request(request, asking("holder"));
      await harness.engine.request(androidRequest, asking("holder"));
      if (holdsIos === true) await harness.engine.request(request, asking("agent-1"));
      void harness.engine.request(request, asking("agent-1")).catch(() => undefined);
      const openOf = (requesterId: string) =>
        harness.registry
          .leaseRequests()
          .filter((record) => record.requesterId === requesterId && record.state === "open");
      await expect.poll(() => openOf("agent-1")).toHaveLength(1);

      const outcome = harness.engine.request(next, asking("agent-1")).catch((e: unknown) => e);

      await harness.engine.settle();
      const state = await settledOrPending(outcome);
      if (refusal === undefined) {
        expect(state).toBe("still pending");
        expect(openOf("agent-1")).toHaveLength(2);
      } else {
        expect(state).toMatchObject({ message: refusal, name: "RequesterAlreadyLeasedError" });
      }
    },
  );

  it.each([
    {
      name: "2, waiting for iOS, then Android: admitted",
      limit: 2,
      granted: [
        ["holder-1", request],
        ["holder-2", androidRequest],
      ],
      waits: request,
      next: androidRequest,
      refusal: undefined,
    },
    {
      name: "2, waiting for iOS, then iOS: refused",
      limit: 2,
      granted: [
        ["holder-1", request],
        ["holder-2", androidRequest],
      ],
      waits: request,
      next: request,
      refusal: waitingMessage,
    },
    {
      name: "1, waiting for iOS, then Android: refused",
      limit: 1,
      granted: [
        ["holder-1", request],
        ["holder-2", androidRequest],
      ],
      waits: request,
      next: androidRequest,
      refusal: "Requester already has a lease or pending request: agent-1",
    },
    {
      name: "2, holding iOS and waiting for Android, then iOS: refused",
      limit: 2,
      granted: [
        ["agent-1", request],
        ["holder-2", androidRequest],
      ],
      waits: androidRequest,
      next: request,
      refusal: waitingMessage,
    },
  ] as const)(
    "with a numeric lease.maxPerRequester, waiting and held requests share the limit across platforms ($name)",
    async ({ limit, granted, waits, next, refusal }) => {
      const clock = new FakeClock(1_000);
      const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
      const harness = await createHarness({
        driver: ios,
        drivers: [ios, android],
        lease: { maxPerRequester: limit },
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
        },
      });
      for (const [requesterId, spec] of granted) {
        await harness.engine.request(spec, asking(requesterId));
      }
      void harness.engine.request(waits, asking("agent-1")).catch(() => undefined);
      await expect
        .poll(() =>
          harness.registry
            .leaseRequests()
            .filter((record) => record.requesterId === "agent-1" && record.state === "open"),
        )
        .toHaveLength(1);

      const outcome = harness.engine.request(next, asking("agent-1")).catch((e: unknown) => e);

      await harness.engine.settle();
      const state = await settledOrPending(outcome);
      if (refusal === undefined) {
        expect(state).toBe("still pending");
      } else {
        expect(state).toMatchObject({ message: refusal, name: "RequesterAlreadyLeasedError" });
      }
    },
  );

  it("with lease.maxPerRequester per platform, a gateway probe is refused only by a waiting probe on its own platform", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      lease: { maxPerRequester: { ios: 1, android: 1 } },
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 2,
      },
    });
    await harness.engine.request(request, asking("holder-1"));
    await harness.engine.request(androidRequest, asking("holder-2"));
    const probe = (spec: typeof request | typeof androidRequest, id: string) =>
      harness.engine
        .request(spec, asking("gw:1:agent-1", { fleetRequestId: id }))
        .catch((e: unknown) => e);
    void probe(request, "fleet_1");
    await expect
      .poll(() => harness.registry.leaseRequests().filter((record) => record.state === "open"))
      .toHaveLength(1);

    const android2 = probe(androidRequest, "fleet_2");
    const ios2 = probe(request, "fleet_3");

    await expect(ios2).resolves.toMatchObject({
      message: expect.stringContaining("already has a waiting iOS request"),
      name: "RequesterAlreadyLeasedError",
    });
    await expect(Promise.race([android2, Promise.resolve("waiting")])).resolves.toBe("waiting");
  });

  it.each([
    {
      name: "Android",
      waiting: ["ios", "android"],
      cancel: "android",
      result: "cancelled",
      left: ["ios"],
    },
    {
      name: "none",
      waiting: ["ios", "android"],
      cancel: undefined,
      result: "cancelled",
      left: ["android"],
    },
    {
      name: "iOS with only Android waiting",
      waiting: ["android"],
      cancel: "ios",
      result: "not-found",
      left: ["android"],
    },
  ] as const)(
    "cancelPending names the platform of the waiting request to cancel, and the earliest without one ($name)",
    async ({ waiting, cancel, result, left }) => {
      const clock = new FakeClock(1_000);
      const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
      const harness = await createHarness({
        driver: ios,
        drivers: [ios, android],
        lease: { maxPerRequester: { ios: 1, android: 1 } },
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
        },
      });
      await harness.engine.request(request, asking("holder-1"));
      await harness.engine.request(androidRequest, asking("holder-2"));
      const specs = { android: androidRequest, ios: request };
      for (const [index, platform] of waiting.entries()) {
        void harness.engine.request(specs[platform], asking("agent-1")).catch(() => undefined);
        await expect
          .poll(() =>
            harness.registry
              .leaseRequests()
              .filter((record) => record.requesterId === "agent-1" && record.state === "open"),
          )
          .toHaveLength(index + 1);
      }

      await harness.engine.settle();
      await expect(harness.engine.cancelPending("agent-1", cancel)).resolves.toBe(result);

      expect(
        harness.registry
          .leaseRequests()
          .filter((record) => record.requesterId === "agent-1" && record.state === "open")
          .map((record) => record.request.platform),
      ).toEqual(left);
    },
  );

  it("pendingRequestOwner names the owner of the waiting request of the platform it names, and of the earliest without one", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      lease: { maxPerRequester: { ios: 1, android: 1 } },
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 2,
      },
    });
    await harness.engine.request(request, asking("holder-1"));
    await harness.engine.request(androidRequest, asking("holder-2"));
    void harness.engine
      .request(request, { ownerId: "ios-owner", requesterId: "agent-1" })
      .catch(() => undefined);
    await expect
      .poll(() => harness.registry.leaseRequests().filter((record) => record.state === "open"))
      .toHaveLength(1);
    void harness.engine
      .request(androidRequest, { ownerId: "android-owner", requesterId: "agent-1" })
      .catch(() => undefined);
    await expect
      .poll(() => harness.registry.leaseRequests().filter((record) => record.state === "open"))
      .toHaveLength(2);

    expect(harness.engine.pendingRequestOwner("agent-1", "android")).toBe("android-owner");
    expect(harness.engine.pendingRequestOwner("agent-1", "ios")).toBe("ios-owner");
    expect(harness.engine.pendingRequestOwner("agent-1")).toBe("ios-owner");
  });

  it("a refusal at the lease limit emits lease.rejected with reason already-leased", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });
    await harness.engine.request(request, asking("agent-1"));
    await harness.engine.request(request, asking("agent-1"));

    await harness.engine.request(request, asking("agent-1")).catch(() => undefined);

    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload),
    ).toEqual([
      {
        reason: "already-leased",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent-1",
        requestSpec: request,
      },
    ]);
  });

  it("releasing one of two leases lets the requester's next request through", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });
    const first = await harness.engine.request(request, asking("agent-1"));
    await harness.engine.request(request, asking("agent-1"));
    await expect(harness.engine.request(request, asking("agent-1"))).rejects.toMatchObject({
      name: "RequesterAlreadyLeasedError",
    });

    await harness.engine.release(first.lease.id, "explicit");

    await expect(harness.engine.request(request, asking("agent-1"))).resolves.toMatchObject({
      lease: { id: expect.stringMatching(/^lse_/) },
    });
  });

  it("at the lease limit, a repeat with a used idempotencyKey gets its stored answer", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });
    const first = await harness.engine.request(
      request,
      asking("agent-1", { idempotencyKey: "k1" }),
    );
    await harness.engine.request(request, asking("agent-1", { idempotencyKey: "k2" }));

    const repeat = await harness.engine.request(
      request,
      asking("agent-1", { idempotencyKey: "k1" }),
    );

    expect(repeat).toEqual(first);
  });

  it("at the lease limit, a request naming a taken lease id gets REQUESTER_ALREADY_LEASED", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });
    await harness.engine.request(request, asking("agent-2", { leaseId: "taken" }));
    await harness.engine.request(request, asking("agent-1"));
    await harness.engine.request(request, asking("agent-1"));

    await expect(
      harness.engine.request(request, asking("agent-1", { leaseId: "taken" })),
    ).rejects.toMatchObject({ name: "RequesterAlreadyLeasedError" });
  });

  it("after a restart with lease.maxPerRequester lowered from 3 to 1, a requester's three running leases are all kept, and its next request is refused naming the earliest one", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const before = await createHarness({
      driver,
      lease: { maxPerRequester: 3 },
      limits: roomy,
    });
    const earliest = await before.engine.request(request, asking("agent-1"));
    before.clock.advance(5);
    await before.engine.request(request, asking("agent-1"));
    await before.engine.request(request, asking("agent-1"));

    const after = await createHarness({
      driver,
      state: before.state,
      lease: { maxPerRequester: 1 },
      limits: roomy,
    });
    await after.engine.convergeRunningCapacity();

    expect(
      after.registry.snapshot.leases.filter((lease) => lease.requesterId === "agent-1"),
    ).toHaveLength(3);
    await expect(after.engine.request(request, asking("agent-1"))).rejects.toMatchObject({
      existingLeaseId: earliest.lease.id,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("a worker still refuses a local request of a requester at its limit while probes of other requesters are granted", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 }, limits: roomy });
    await harness.engine.request(request, asking("agent-1"));
    await harness.engine.request(request, asking("agent-1"));

    await expect(harness.engine.request(request, asking("agent-1"))).rejects.toMatchObject({
      name: "RequesterAlreadyLeasedError",
    });
    await expect(
      harness.engine.request(request, {
        fleetRequestId: "req_gw1",
        noWait: true,
        ownerId: "gw:two",
        requesterId: "gw:two",
      }),
    ).resolves.toMatchObject({ lease: { id: expect.stringMatching(/^lse_/) } });
  });
});
