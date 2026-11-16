import { describe, expect, it, vi } from "vitest";
import { DriverCrashError } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { request, createHarness, seedReady, flush } from "./test-create-leasing.js";
import { DaemonUpdatingError, ProvisionFailedError, RequestCancelledError } from "./index.js";

describe("createLeasing: a waiting request says why it is not placed (#636)", () => {
  const runningLimit = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 2, maxRunning: 1 },
    maxRunning: 2,
  };
  const asking = (requesterId: string, more: Record<string, unknown> = {}) => ({
    ownerId: requesterId,
    requesterId,
    ...more,
  });
  const listing = (harness: Awaited<ReturnType<typeof createHarness>>) =>
    harness.engine.waitingRequests().map((entry) => ({
      reason: (entry as { reason?: string }).reason,
      requesterId: entry.requesterId,
      stage: entry.stage,
    }));

  it("lists a queued request at the iOS running limit as platform-running-limit and one behind it as behind-earlier-request, and stores no reason", async () => {
    const harness = await createHarness({ limits: runningLimit });
    await harness.engine.request(request, asking("holder"));
    void harness.engine.request(request, asking("head"));
    void harness.engine.request(request, asking("behind"));
    await flush();

    expect(listing(harness)).toEqual([
      { reason: "platform-running-limit", requesterId: "head", stage: "queued" },
      { reason: "behind-earlier-request", requesterId: "behind", stage: "queued" },
    ]);
    const stored = harness.registry.leaseRequests().find((record) => record.requesterId === "head");
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("reason");
  });

  it("follows the latest attempt: when the head is granted, the request behind it lists its own new reason", async () => {
    const harness = await createHarness({ limits: runningLimit });
    const holder = await harness.engine.request(request, asking("holder"));
    const head = harness.engine.request(request, asking("head"));
    void harness.engine.request(request, asking("behind"));
    await flush();

    await harness.engine.release(holder.lease.id, "explicit");
    await head;
    await harness.engine.settle();

    expect(listing(harness)).toEqual([
      { reason: "platform-running-limit", requesterId: "behind", stage: "queued" },
    ]);
  });

  it("cancelling the queued head makes the request behind it plan again and list its own reason", async () => {
    const harness = await createHarness({ limits: runningLimit });
    await harness.engine.request(request, asking("holder"));
    const head = harness.engine.request(request, asking("head"));
    void harness.engine.request(request, asking("behind"));
    await flush();

    await expect(harness.engine.cancelPending("head")).resolves.toBe("cancelled");
    await expect(head).rejects.toBeInstanceOf(RequestCancelledError);
    await flush();

    expect(listing(harness)).toEqual([
      { reason: "platform-running-limit", requesterId: "behind", stage: "queued" },
    ]);
  });

  it("plans again at once after a first provisioning failure, and a success then grants", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
    const harness = await createHarness({ driver });

    const granted = await harness.engine.request(request, asking("retried"));

    expect(granted.lease.id).toBeDefined();
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    expect(listing(harness)).toEqual([]);
  });

  it("rejects a request whose provision failed twice with PROVISION_FAILED, lists nothing for it, and the request behind it plans again", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 50 },
      platform: "ios",
    });
    driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
    driver.failOn("provision", 2, new DriverCrashError("simulator exited again"));
    const harness = await createHarness({ driver });
    const rejected = harness.engine
      .request(request, asking("failing"))
      .catch((error: unknown) => error);
    await flush();
    clock.advance(50);
    await flush();
    void harness.engine.request(request, asking("meanwhile"));
    await flush();
    expect(listing(harness)).toEqual([
      { reason: undefined, requesterId: "failing", stage: "starting" },
      { reason: "device-limit", requesterId: "meanwhile", stage: "queued" },
    ]);
    expect(harness.engine.waitingRequests()[0]).not.toHaveProperty("reason");

    clock.advance(50);
    await flush();

    expect(await rejected).toBeInstanceOf(ProvisionFailedError);
    expect(await rejected).toMatchObject({ message: "simulator exited again" });
    expect(listing(harness)).toEqual([
      { reason: undefined, requesterId: "meanwhile", stage: "starting" },
    ]);
  });

  it("refuses a queued request when the update hold begins and still grants the one that is provisioning", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 50 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, limits: runningLimit });
    const provisioning = harness.engine
      .request(request, asking("provisioning"))
      .catch((error: unknown) => error);
    await flush();
    const queued = harness.engine
      .request(request, asking("queued"))
      .catch((error: unknown) => error);
    await flush();
    expect(listing(harness)).toEqual([
      { reason: undefined, requesterId: "provisioning", stage: "starting" },
      { reason: "platform-running-limit", requesterId: "queued", stage: "queued" },
    ]);

    await harness.engine.leasing.holdForUpdate();
    clock.advance(50);
    await flush();

    expect(await queued).toBeInstanceOf(DaemonUpdatingError);
    expect(await provisioning, "the request that was provisioning").toMatchObject({
      lease: { id: expect.any(String) },
    });
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload as { requester: string; reason: string })
        .map(({ requester, reason }) => [requester, reason]),
    ).toEqual([["queued", "updating"]]);
  });

  it("refuses the retry of a provision that fails while the update hold is on, with DAEMON_UPDATING and no second provision", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 50 },
      platform: "ios",
    });
    driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
    const harness = await createHarness({ driver, limits: runningLimit });
    const failing = harness.engine
      .request(request, asking("failing"))
      .catch((error: unknown) => error);
    await flush();

    await harness.engine.leasing.holdForUpdate();
    clock.advance(50);
    await flush();
    clock.advance(50);
    await flush();

    expect(await failing).toBeInstanceOf(DaemonUpdatingError);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload as { requester: string; reason: string })
        .map(({ requester, reason }) => [requester, reason]),
    ).toEqual([["failing", "updating"]]);
  });

  it("refuses a request that is still resolving its spec when the update hold begins", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { resolveSpec: 50 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, limits: runningLimit });
    const resolving = harness.engine
      .request(request, asking("resolving"))
      .catch((error: unknown) => error);
    await flush();

    await harness.engine.leasing.holdForUpdate();
    clock.advance(50);
    await flush();

    expect(await resolving, "the request that was resolving").toBeInstanceOf(DaemonUpdatingError);
    expect(driver.calls.map((call) => call.operation)).not.toContain("provision");
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload as { requester: string; reason: string })
        .map(({ requester, reason }) => [requester, reason]),
    ).toEqual([["resolving", "updating"]]);
  });

  it("lists a request that waits for a device the warm pool is booting as waiting-for-device", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      knownModels: ["iPhone 16"],
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const harness = await createHarness({
      startPool: true,
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    const granting = harness.engine.request(request, asking("a"));
    await flush();
    clock.advance(50);
    const first = await granting;
    await harness.engine.release(first.lease.id, "explicit");
    await vi.waitFor(() =>
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
    );

    void harness.engine.request(request, asking("b"));
    await flush();

    expect(listing(harness)).toEqual([
      { reason: "waiting-for-device", requesterId: "b", stage: "queued" },
    ]);
  });

  it("lists a request whose eviction failed as the capacity reason that asked for it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop victim"));
    const harness = await createHarness({ driver, limits: runningLimit });
    await seedReady(harness);

    void harness.engine.request({ ...request, model: "iPhone SE" }, asking("new-spec"));
    await flush();

    expect(listing(harness)).toEqual([
      { reason: "platform-running-limit", requesterId: "new-spec", stage: "queued" },
    ]);
  });

  it("lists a request whose only match is being destroyed as the capacity reason its plan gave", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { destroy: 20 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, asking("first"));
    await harness.engine.release(first.lease.id, "explicit");

    void harness.engine.request(request, asking("second"));
    await flush();

    expect(listing(harness)).toEqual([
      { reason: "device-limit", requesterId: "second", stage: "queued" },
    ]);
  });
});
