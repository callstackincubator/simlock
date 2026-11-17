import { describe, expect, it } from "vitest";
import { type LeaseGrant, DriverCrashError } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { type EventMap } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { request, config, createHarness, flush, settledOrPending } from "./test-create-leasing.js";
import { NoCapacityError, ProvisionFailedError, QueueTimeoutError } from "./index.js";

describe("createLeasing: a gateway dispatch is a probe (ADR 0021)", () => {
  type Harness = Awaited<ReturnType<typeof createHarness>>;

  const holder = { ownerId: "holder", requesterId: "holder" };
  const probeOf = (requesterId: string, extra: Record<string, unknown> = {}) => ({
    fleetRequestId: "req_gw1",
    noWait: true,
    ownerId: requesterId,
    requesterId,
    ...extra,
  });

  function payloads<
    Name extends
      | "lease.declined"
      | "lease.rejected"
      | "lease.requested"
      | "lease.queued"
      | "lease.granted",
  >(harness: Harness, name: Name): Array<EventMap[Name]> {
    return harness.bus
      .replay()
      .filter((event) => event.event === name)
      .map((event) => event.payload as EventMap[Name]);
  }

  async function admittedId(harness: Harness, requesterId: string): Promise<string | undefined> {
    return harness.registry.leaseRequests().find((record) => record.requesterId === requesterId)
      ?.id;
  }

  interface Declined {
    readonly harness: Harness;
    readonly payload: unknown;
    readonly check?: () => void;
  }

  const declinedCases: ReadonlyArray<readonly [string, () => Promise<Declined>]> = [
    [
      "no-wait",
      async () => {
        const harness = await createHarness();
        await harness.engine.request(request, holder);
        await expect(harness.engine.request(request, probeOf("gw:one"))).rejects.toBeInstanceOf(
          NoCapacityError,
        );
        return {
          harness,
          payload: {
            fleetRequestId: "req_gw1",
            reason: "no-wait",
            requestId: await admittedId(harness, "gw:one"),
            requestSpec: request,
            requester: "gw:one",
          },
        };
      },
    ],
    [
      "unresolvable-spec",
      async () => {
        const harness = await createHarness();
        const odd = { ...request, model: "iPhone 99 Imaginary", osVersion: ">=18" };
        await settledOrPending(harness.engine.request(odd, probeOf("gw:odd")));
        return {
          harness,
          payload: expect.objectContaining({
            fleetRequestId: "req_gw1",
            reason: "unresolvable-spec",
            requestSpec: odd,
          }),
        };
      },
    ],
    [
      "already-leased",
      async () => {
        const driver = new FakeDriver({
          availableOsVersions: ["26.5"],
          clock: new FakeClock(1_000),
          platform: "ios",
        });
        driver.hangMakeReady();
        const harness = await createHarness({ driver });
        void harness.engine.request(request, probeOf("gw:one")).catch(() => undefined);
        await expect
          .poll(() =>
            harness.registry.leaseRequests().find((record) => record.requesterId === "gw:one"),
          )
          .toMatchObject({ state: "open" });
        await expect(harness.engine.request(request, probeOf("gw:one"))).rejects.toMatchObject({
          name: "RequesterAlreadyLeasedError",
        });
        return {
          harness,
          payload: {
            fleetRequestId: "req_gw1",
            reason: "already-leased",
            requestId: expect.stringMatching(/^req_/),
            requestSpec: request,
            requester: "gw:one",
          },
        };
      },
    ],
    [
      "lease-id-taken",
      async () => {
        const harness = await createHarness({
          limits: {
            android: { maxDevices: 2, maxRunning: 2 },
            ios: { maxDevices: 3, maxRunning: 3 },
            maxRunning: 4,
          },
        });
        await harness.engine.request(request, { ...holder, leaseId: "myid" });
        await settledOrPending(
          harness.engine.request(request, probeOf("gw:two", { leaseId: "myid" })),
        );
        return {
          harness,
          payload: expect.objectContaining({ fleetRequestId: "req_gw1", reason: "lease-id-taken" }),
        };
      },
    ],
    [
      "lease-ended",
      async () => {
        const harness = await createHarness();
        await harness.engine.request(request, { ...holder, leaseId: "myid" });
        await harness.engine.release("myid", "explicit");
        await expect(
          harness.engine.request(request, probeOf("gw:two", { leaseId: "myid" })),
        ).rejects.toMatchObject({ code: "LEASE_ENDED" });
        return {
          harness,
          payload: expect.objectContaining({ fleetRequestId: "req_gw1", reason: "lease-ended" }),
        };
      },
    ],
    [
      "boot-timeout",
      async () => {
        const driver = new FakeDriver({
          availableOsVersions: ["26.5"],
          clock: new FakeClock(1_000),
          platform: "ios",
        });
        driver.failOn("makeReady", 1, new Error("boot failed"));
        const harness = await createHarness({ driver });
        const stages: string[] = [];
        await settledOrPending(
          harness.engine.request(request, {
            ...probeOf("gw:slow"),
            onProgress: (progress) => stages.push(progress.stage),
          }),
        );
        return {
          check: () => expect(stages.length).toBeGreaterThan(0),
          harness,
          payload: expect.objectContaining({ fleetRequestId: "req_gw1", reason: "boot-timeout" }),
        };
      },
    ],
    [
      "daemon-restarted",
      async () => {
        const driver = new FakeDriver({
          availableOsVersions: ["26.5"],
          clock: new FakeClock(1_000),
          platform: "ios",
        });
        driver.hangMakeReady();
        const before = await createHarness({ driver });
        void before.engine.request(request, probeOf("gw:open")).catch(() => undefined);
        await expect
          .poll(() =>
            before.registry.leaseRequests().find((record) => record.requesterId === "gw:open"),
          )
          .toMatchObject({ fleetRequestId: "req_gw1", state: "open" });
        const requestId = await admittedId(before, "gw:open");
        const after = await createHarness({ state: before.state });
        await after.engine.convergeRunningCapacity();
        return {
          harness: after,
          payload: {
            fleetRequestId: "req_gw1",
            reason: "daemon-restarted",
            requestId,
            requestSpec: request,
            requester: "gw:open",
          },
        };
      },
    ],
  ];

  it.each(declinedCases)(
    "emits one lease.declined with its fleetRequestId and reason %s, and no lease.rejected, for a probe refused that way",
    async (_reason, run) => {
      const { check, harness, payload } = await run();

      expect(payloads(harness, "lease.declined")).toEqual([payload]);
      expect(payloads(harness, "lease.rejected")).toEqual([]);
      check?.();
    },
  );

  it("still emits lease.rejected no-wait, and no lease.declined, for a local noWait request with no room", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, holder);

    await expect(
      harness.engine.request(request, { noWait: true, ownerId: "local", requesterId: "local" }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(payloads(harness, "lease.rejected")).toEqual([
      expect.objectContaining({ reason: "no-wait", requester: "local" }),
    ]);
    expect(payloads(harness, "lease.declined")).toEqual([]);
  });

  it("carries a probe's fleetRequestId on its lease.requested and lease.granted, and none on a local request's", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });

    await harness.engine.request(request, probeOf("gw:one"));
    await harness.engine.request(request, { ownerId: "local", requesterId: "local" });

    const [requestedProbe, requestedLocal] = payloads(harness, "lease.requested");
    const [grantedProbe, grantedLocal] = payloads(harness, "lease.granted");
    expect(requestedProbe).toMatchObject({ fleetRequestId: "req_gw1", requester: "gw:one" });
    expect(grantedProbe).toMatchObject({ fleetRequestId: "req_gw1", requester: "gw:one" });
    expect(requestedLocal).toMatchObject({ requester: "local" });
    expect(requestedLocal).not.toHaveProperty("fleetRequestId");
    expect(grantedLocal).toMatchObject({ requester: "local" });
    expect(grantedLocal).not.toHaveProperty("fleetRequestId");
  });

  it.each([
    { name: "a number", maxPerRequester: undefined },
    { name: "a per-platform object", maxPerRequester: { ios: 1, android: 1 } },
  ])(
    "a worker grants a probe for a requester that already holds a lease from an earlier probe, lease.maxPerRequester being $name",
    async ({ maxPerRequester }) => {
      const harness = await createHarness({
        ...(maxPerRequester === undefined ? {} : { lease: { maxPerRequester } }),
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 3, maxRunning: 3 },
          maxRunning: 4,
        },
      });
      const first = await harness.engine.request(request, probeOf("gw:one"));

      const second = await harness.engine.request(request, probeOf("gw:one"));

      expect(second.lease.id).not.toBe(first.lease.id);
      expect(
        harness.registry.snapshot.leases.filter((lease) => lease.requesterId === "gw:one"),
      ).toHaveLength(2);
    },
  );

  it("declines, rather than rejects, a request carrying fleetRequestId whose wait in the queue times out", async () => {
    // why: The dispatcher only lets a probe in with noWait, so none is ever queued; this reaches the
    // queue's timeout site directly, which applies the same rule as every other.
    const harness = await createHarness();
    await harness.engine.request(request, holder);
    const waiting = harness.engine.request(request, {
      ...probeOf("gw:late", { noWait: false }),
      timeoutMs: 10,
    });
    await flush();
    harness.clock.advance(10);

    expect(await settledOrPending(waiting)).toBeInstanceOf(QueueTimeoutError);

    expect(payloads(harness, "lease.declined")).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", reason: "timeout" }),
    ]);
    expect(payloads(harness, "lease.rejected")).toEqual([]);
  });

  describe("a provision that fails twice", () => {
    function failingTwice() {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
      driver.failOn("provision", 2, new DriverCrashError("simulator exited again"));
      return driver;
    }

    it("declines a probe with reason no-wait, answers PROVISION_FAILED with the driver's message, and emits no lease.queued", async () => {
      const harness = await createHarness({ driver: failingTwice() });

      const outcome = await settledOrPending(harness.engine.request(request, probeOf("gw:one")));

      expect(outcome).toBeInstanceOf(ProvisionFailedError);
      expect(outcome).toMatchObject({ message: "simulator exited again" });
      expect(payloads(harness, "lease.declined")).toEqual([
        expect.objectContaining({ fleetRequestId: "req_gw1", reason: "no-wait" }),
      ]);
      expect(payloads(harness, "lease.queued")).toEqual([]);
      expect(payloads(harness, "lease.rejected")).toEqual([]);
    });

    it("rejects a local request in the same case with PROVISION_FAILED, lists nothing and emits no lease.queued", async () => {
      const harness = await createHarness({ driver: failingTwice() });

      const outcome = await settledOrPending(
        harness.engine.request(request, { ownerId: "local", requesterId: "local" }),
      );

      expect(outcome).toBeInstanceOf(ProvisionFailedError);
      expect(outcome).toMatchObject({ message: "simulator exited again" });
      expect(harness.engine.waitingRequests()).toEqual([]);
      expect(payloads(harness, "lease.queued")).toEqual([]);
      expect(payloads(harness, "lease.declined")).toEqual([]);
    });
  });
});

describe("createLeasing after a quarantine retry (ADR 0022 §2)", () => {
  it("grants a request that waits at capacity a new simulator once the retry has deleted the quarantined one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, { ownerId: "first", requesterId: "first" });
    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");
    const waiting = harness.engine.request(request, { ownerId: "second", requesterId: "second" });
    await flush();

    harness.clock.advance(config().warmPool.quarantine.retryBackoffMs);
    await flush();

    const granted = (await settledOrPending(waiting)) as LeaseGrant;
    expect(granted).toMatchObject({ lease: { requesterId: "second" } });
    expect(granted.device.id).not.toBe(first.device.id);
    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("deleted");
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("reports a warm target of one for the quarantined simulator's spec as ready 1 once the retry has deleted it and the pool has created a new one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    const harness = await createHarness({
      driver,
      warmPool: { targets: [{ count: 1, model: "iPhone 16", osVersion: "26.5", platform: "ios" }] },
    });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();
    const first = await harness.engine.request(request, { ownerId: "first", requesterId: "first" });
    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");
    expect(harness.engine.core.warmPoolReader.figures().targets[0]?.ready).toBe(0);

    harness.clock.advance(config().warmPool.quarantine.retryBackoffMs);
    await flush();
    await harness.engine.settle();

    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "device.deleted")
        .map((event) => (event.payload as { deviceId: string }).deviceId),
    ).toEqual([first.device.id]);
    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("deleted");
    expect(harness.engine.core.warmPoolReader.figures().targets).toMatchObject([
      { count: 1, ready: 1 },
    ]);
  });
});
