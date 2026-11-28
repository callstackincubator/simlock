import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import { DriverCrashError, type ManagedDeviceLifecycle } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import { RequesterAlreadyLeasedError } from "./wait-queue.js";
import {
  request,
  createHarness,
  seedReady,
  flush,
  settle,
  seedShutdown,
} from "./test-lease-acquisition.js";
import { inspectCommits } from "./test-lease-acquisition-commits.js";

// why: drives the coordinator on its own, so a test can interleave its lifecycle, queue and clock in orders the leasing surface cannot force.
describe("LeaseAcquisitionCoordinator", () => {
  it("prepares a warm device before granting when its driver requires it", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    Object.defineProperty(harness.driver, "rebootReadyBeforeGrant", { value: true });
    let release!: () => void;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = harness.driver.makeReady.bind(harness.driver);
    const ready = vi.spyOn(harness.driver, "makeReady").mockImplementation(async (...args) => {
      started();
      await gate;
      return original(...args);
    });
    const grant = harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });
    const state = promiseState(grant);
    await preparing;
    await settle();
    expect(state.state, "grant waits for preparation").toBe("pending");
    release();
    expect((await grant).device.id).toBe("dev_0");
    expect(device.id).toBe("dev_0");
    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: device.driverDeviceId }),
      expect.objectContaining({ purpose: "prepare" }),
    );
  });

  it("rejects a second request from a requester whose first is still pending, under no key or a new idempotency key, with lease.rejected already-leased", async () => {
    // why: the one-lease-or-pending-request-per-requester rule is enforced here, inside the admission
    // decision, and nowhere below it: the queue keeps no check of its own. A requester holding a
    // lease is createLeasing's "with no lease.maxPerRequester, a requester holding a lease is refused" case.
    const harness = await createHarness({ maxDevices: 1, maxRunning: 1 });
    await harness.coordinator.request(request, { ownerId: "holder", requesterId: "holder" });
    const pending = harness.coordinator.request(request, {
      idempotencyKey: "key-1",
      ownerId: "agent",
      requesterId: "agent",
    });
    pending.catch(() => undefined);
    await flush();
    const rejections: unknown[] = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejections.push(envelope.payload));

    const duplicate = harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });
    const duplicateState = promiseState(duplicate);
    await flush();

    expect(duplicateState.state).toBe("rejected");
    await expect(duplicate).rejects.toMatchObject({
      existingLeaseId: undefined,
      name: "RequesterAlreadyLeasedError",
      requesterId: "agent",
    });
    expect(rejections).toEqual([
      {
        reason: "already-leased",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent",
        requestSpec: request,
      },
    ]);
    expect(harness.coordinator.queueDepth).toBe(1);

    const otherKey = harness.coordinator.request(request, {
      idempotencyKey: "key-2",
      ownerId: "agent",
      requesterId: "agent",
    });
    const otherKeyState = promiseState(otherKey);
    await flush();

    expect(otherKeyState.state).toBe("rejected");
    await expect(otherKey).rejects.toBeInstanceOf(RequesterAlreadyLeasedError);
    expect(rejections).toHaveLength(2);
    expect(rejections[1]).toMatchObject({ reason: "already-leased", requester: "agent" });
    expect(harness.coordinator.queueDepth).toBe(1);
  });

  it.each([
    [
      "provisioned",
      { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
      { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
    ],
    [
      "ready",
      { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
      { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
    ],
    ["provisioned", undefined, {}],
  ] as const)(
    "hands the owning driver's lease environment to a %s device's grant (driver environment %j, grant %j)",
    async (path, leaseEnvironment, expected) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        ...(leaseEnvironment === undefined ? {} : { leaseEnvironment }),
        platform: "ios",
      });
      const harness = await createHarness({ drivers: [driver] });
      // Both acquisition paths funnel through the same construction site; asserting only
      // the fresh-provision one would leave a warm-pool grant free to carry nothing.
      if (path === "ready") await seedReady(harness);

      const granted = await harness.coordinator.request(request, {
        ownerId: "agent",
        requesterId: "agent",
      });

      expect(granted.environment).toEqual(expected);
    },
  );

  it("rejects missing drivers and unresolved specs without leaving pending demand", async () => {
    const empty = await createHarness({ drivers: [] });
    await expect(
      empty.coordinator.request(request, {
        ownerId: "missing-driver",
        requesterId: "missing-driver",
      }),
    ).rejects.toThrow("No driver registered");
    expect(empty.coordinator.queueDepth).toBe(0);

    const harness = await createHarness();
    await expect(
      harness.coordinator.request(
        { ...request, osVersion: "99" },
        { ownerId: "bad-spec", requesterId: "bad-spec" },
      ),
    ).rejects.toThrow("Runtime missing");
    expect(harness.coordinator.queueDepth).toBe(0);
  });

  it("grants a request queued while a new device was booting a second new device once the first is granted, with no release", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    harness.driver.hangMakeReady();

    const first = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondDeviceId: string | undefined;
    void second.then((grant) => {
      secondDeviceId = grant.device.id;
    });
    await settle();
    expect(harness.coordinator.queueDepth).toBe(1);

    harness.driver.releaseMakeReady();
    const firstGrant = await first;
    await settle();

    expect({
      queueDepth: harness.coordinator.queueDepth,
      secondGranted: secondDeviceId !== undefined,
      sameDevice: secondDeviceId === firstGrant.device.id,
    }).toEqual({ queueDepth: 0, secondGranted: true, sameDevice: false });
  });

  it("grants a request queued behind an in-flight head the device the pool created for it, with no provision of its own", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    harness.driver.hangMakeReady();
    const first = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    const granted: Record<string, string> = {};
    for (const agent of ["b", "c"]) {
      void harness.coordinator
        .request(request, { ownerId: agent, requesterId: agent })
        .then((grant) => {
          granted[agent] = grant.device.id;
        });
    }
    await settle();
    expect(harness.coordinator.waitingDemand()).toMatchObject([
      { inFlight: true, spec: request },
      { inFlight: false, spec: request },
      { inFlight: false, spec: request },
    ]);

    const reservation = { release: () => undefined };
    const created = [
      harness.provisioner.provision(request, { claim: { kind: "boot" }, reservation }),
      harness.provisioner.provision(request, { claim: { kind: "boot" }, reservation }),
    ];
    await settle();
    harness.driver.releaseMakeReady();
    const [firstGrant, ...handoffs] = await Promise.all([first, ...created]);
    for (const handoff of handoffs) handoff.claim.release();
    harness.coordinator.kick();
    await settle();

    expect({
      distinct: new Set([firstGrant.device.id, ...Object.values(granted)]).size,
      granted: Object.keys(granted).sort(),
      provisioned: harness.driver.calls.filter((call) => call.operation === "provision").length,
    }).toEqual({ distinct: 3, granted: ["b", "c"], provisioned: 3 });
    expect(Object.values(granted).sort()).toEqual(
      handoffs.map((handoff) => handoff.device.id).sort(),
    );
  });

  it("grants a request queued behind another request booting a shut-down device once that device is granted, with no release", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const held = await Promise.all([
      harness.coordinator.request(request, { ownerId: "x", requesterId: "x" }),
      harness.coordinator.request(request, { ownerId: "y", requesterId: "y" }),
    ]);
    const booting = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    // Both devices come back shut down without the release path, so only the kick below wakes
    // the queue; its head boots one of them and holds there.
    harness.driver.hangMakeReady();
    for (const grant of held) {
      await harness.registry.beginRelease(grant.lease.id);
      await harness.registry.transitionDevice(grant.device.id, "shutdown", {
        event: "device.reclaimed",
        payload: { deviceId: grant.device.id, duration: 0, strategy: "wipe" },
      });
    }
    harness.coordinator.kick();
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondDeviceId: string | undefined;
    void second.then((grant) => {
      secondDeviceId = grant.device.id;
    });
    await settle();
    expect(harness.coordinator.queueDepth).toBe(2);

    harness.driver.releaseMakeReady();
    const bootedGrant = await booting;
    await settle();

    expect({
      queueDepth: harness.coordinator.queueDepth,
      secondGranted: secondDeviceId !== undefined,
      sameDevice: secondDeviceId === bootedGrant.device.id,
    }).toEqual({ queueDepth: 0, secondGranted: true, sameDevice: false });
  });

  it("grants a request queued behind a request whose shut-down device failed to boot, when another shut-down device and a running slot are free, with no release", async () => {
    const harness = await createHarness({ maxDevices: 3, maxRunning: 2 });
    // why: a released virtual device is destroyed, so the shut-down devices are seeded, and a
    // leased device holds one running slot: the head's boot takes the other, so the request
    // behind it queues until that boot fails and gives the slot back.
    await harness.coordinator.request(request, { ownerId: "x", requesterId: "x" });
    const shutdown = [await seedShutdown(harness), await seedShutdown(harness)];
    // why: makeready calls 1 to 3 readied the leased device and the seeded ones; call 4 is the head's boot.
    harness.driver.failOn("makeReady", 4, new DriverCrashError("simulator never booted"));
    const failing = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    void failing.catch(() => undefined);
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    const secondState = promiseState(second);
    await settle();
    await expect(failing).rejects.toMatchObject({ name: "BootTimeoutError" });
    const failedDeviceId = (
      harness.driver.calls.filter((call) => call.operation === "destroy")[0]?.arguments[0] as
        | { readonly deviceId: string }
        | undefined
    )?.deviceId;
    const otherDevice = shutdown.find((device) => device.driverDeviceId !== failedDeviceId);

    expect({ queueDepth: harness.coordinator.queueDepth, second: secondState.state }).toEqual({
      queueDepth: 0,
      second: "fulfilled",
    });
    expect(failedDeviceId).toBeDefined();
    expect(otherDevice).toBeDefined();
    expect((await second).device.id).toBe(otherDevice?.id);
  });

  it("leaves a request that still cannot be served queued once, with no new work, when the device it queued behind is granted", async () => {
    const harness = await createHarness({ maxDevices: 1, maxRunning: 1 });
    harness.driver.hangMakeReady();
    const queuedEvents: unknown[] = [];
    harness.bus.subscribe("lease.queued", (envelope) => {
      queuedEvents.push(envelope.payload);
    });
    const progress: string[] = [];

    const first = harness.coordinator.request(request, { ownerId: "a", requesterId: "a" });
    await settle();
    const second = harness.coordinator.request(request, {
      onProgress: (update) => progress.push(update.stage),
      ownerId: "b",
      requesterId: "b",
    });
    void second.catch(() => undefined);
    await settle();

    harness.driver.releaseMakeReady();
    await first;
    await settle();

    expect({
      progress,
      provisions: harness.driver.calls.filter((call) => call.operation === "provision").length,
      queueDepth: harness.coordinator.queueDepth,
      queuedEvents: queuedEvents.length,
    }).toEqual({ progress: ["queued"], provisions: 1, queueDepth: 1, queuedEvents: 1 });
  });

  it("boots shutdown inventory and evicts managed demand before provisioning", async () => {
    // why: two devices are allowed here, so a request that provisioned instead of booting would
    // get a device of its own and leave the shut-down one alone.
    const bootHarness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const ready = await seedReady(bootHarness);
    await bootHarness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
    await bootHarness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    const progress: string[] = [];
    const provisionsBefore = bootHarness.driver.calls.filter(
      (call) => call.operation === "provision",
    ).length;
    await expect(
      bootHarness.coordinator.request(request, {
        onProgress: (update) => progress.push(update.stage),
        requesterId: "boot",
        ownerId: "boot",
      }),
    ).resolves.toMatchObject({ device: { id: ready.id } });
    expect(progress).toEqual(["booting"]);
    expect(bootHarness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(
      provisionsBefore,
    );

    const eviction = await createHarness();
    const old = await seedReady(eviction, { ...request, model: "iPhone SE" });
    await expect(
      eviction.coordinator.request(request, {
        ownerId: "new-spec",
        requesterId: "new-spec",
      }),
    ).resolves.toMatchObject({ device: { spec: request } });
    expect(eviction.registry.snapshot.devices.find((device) => device.id === old.id)?.state).toBe(
      "deleted",
    );
    const operations = eviction.driver.calls.map((call) => call.operation);
    expect(operations.indexOf("destroy")).toBeGreaterThan(-1);
    expect(operations.lastIndexOf("provision")).toBeGreaterThan(operations.indexOf("destroy"));
  });

  it("drains a cancelled in-flight boot before maintenance returns", async () => {
    const harness = await createHarness();
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();
    const makeReadyBeforeRequest = harness.driver.calls.filter(
      (call) => call.operation === "makeReady",
    ).length;

    const acquisition = harness.coordinator.request(request, {
      requesterId: "drained",
      ownerId: "drained",
    });
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      makeReadyBeforeRequest + 1,
    );

    let maintenanceReturned = false;
    const maintenance = harness.coordinator.beginMaintenance().then(() => {
      maintenanceReturned = true;
    });
    await flush();
    expect(maintenanceReturned).toBe(false);
    expect(harness.registry.snapshot.leases).toEqual([]);
    await expect(
      harness.coordinator.request(request, {
        ownerId: "during-maintenance",
        requesterId: "during-maintenance",
      }),
    ).rejects.toMatchObject({ name: "NukeCancelledError" });

    harness.driver.releaseMakeReady();
    await maintenance;
    await expect(acquisition).rejects.toMatchObject({ name: "NukeCancelledError" });
    expect(harness.registry.snapshot.leases).toEqual([]);

    await harness.coordinator.endMaintenance();
  });

  it("coalesces simultaneous kicks for the same queued waiter", async () => {
    const harness = await createHarness({ maxDevices: 2 });
    const first = await harness.coordinator.request(request, {
      requesterId: "first",
      ownerId: "first",
    });
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });

    const queued = harness.coordinator.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();
    harness.driver.hangMakeReady();
    await harness.registry.beginRelease(first.lease.id);
    const leased = harness.registry.snapshot.devices.find(
      (candidate) => candidate.id === first.device.id,
    );
    if (leased === undefined) throw new Error("expected leased device");
    await harness.registry.transitionDevice(leased.id, "shutdown", {
      event: "device.reclaimed",
      payload: { deviceId: leased.id, duration: 0, strategy: "wipe" },
    });

    const makeReadyBeforeKick = harness.driver.calls.filter(
      (call) => call.operation === "makeReady",
    ).length;
    harness.coordinator.kick();
    harness.coordinator.kick();
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      makeReadyBeforeKick + 1,
    );

    let maintenanceReturned = false;
    const maintenance = harness.coordinator.beginMaintenance().then(() => {
      maintenanceReturned = true;
    });
    await flush();
    expect(maintenanceReturned).toBe(false);
    harness.driver.releaseMakeReady();
    await maintenance;
    await expect(queued).rejects.toMatchObject({ name: "NukeCancelledError" });
    await harness.coordinator.endMaintenance();
  });

  it("cancels a queued request, emits lease.rejected(cancelled), and frees the requester immediately", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    const queued = harness.coordinator.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);

    const rejections: unknown[] = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejections.push(envelope.payload));

    await expect(harness.coordinator.cancelPending("queued")).resolves.toBe("cancelled");
    await expect(queued).rejects.toMatchObject({ name: "RequestCancelledError" });
    expect(harness.coordinator.queueDepth).toBe(0);
    expect(rejections).toContainEqual({
      reason: "cancelled",
      requestId: expect.stringMatching(/^req_/),
      requester: "queued",
      requestSpec: request,
    });

    // No capacity remains (still held by "first"), but crucially this is NoCapacityError,
    // not RequesterAlreadyLeasedError -- the cancelled requester is no longer pending.
    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "queued",
        requesterId: "queued",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("reports not-found for a requester with no pending waiter", async () => {
    const harness = await createHarness();
    await expect(harness.coordinator.cancelPending("nobody")).resolves.toBe("not-found");
  });

  it("reports not-cancellable while device work is already in flight", async () => {
    const harness = await createHarness();
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();

    const acquisition = harness.coordinator.request(request, {
      requesterId: "booting",
      ownerId: "booting",
    });
    await flush();

    await expect(harness.coordinator.cancelPending("booting")).resolves.toBe("not-cancellable");

    harness.driver.releaseMakeReady();
    await expect(acquisition).resolves.toMatchObject({ device: { id: shutdown.id } });
  });

  it("delivers the grant to a queued waiter whose queue timeout falls due while its lease is being written", async () => {
    const harness = await createHarness();
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const waiting = harness.coordinator.request(request, {
      ownerId: "waiter",
      requesterId: "waiter",
      timeoutMs: 100,
    });
    const waitingOutcome = promiseState(waiting);
    let callerError: string | undefined;
    void waiting.then(undefined, (error: unknown) => {
      callerError = (error as Error).name;
    });
    await flush();
    expect({
      now: harness.clock.now(),
      outcome: waitingOutcome.state,
      queueDepth: harness.coordinator.queueDepth,
    }).toEqual({ now: 1_000, outcome: "pending", queueDepth: 1 });

    let deadlineFellDueDuringTheGrantWrite = false;
    // why: a real clock keeps turning while a commit is in flight, so the only faithful way to
    // put this waiter's timeout inside the grant's write is to advance it from the commit itself.
    inspectCommits(harness, ({ leaseRequesters }) => {
      if (leaseRequesters.includes("waiter")) {
        harness.clock.advance(100);
        deadlineFellDueDuringTheGrantWrite = harness.clock.now() >= 1_100;
      }
    });

    await harness.registry.beginRelease(held.lease.id);
    await harness.registry.completeReclaimWithoutPurge(held.device.id);
    harness.coordinator.kick();
    await settle();

    expect({
      callerError,
      deadlineFellDueDuringTheGrantWrite,
      deviceStates: harness.registry.snapshot.devices.map((device) => device.state),
      leaseRequesters: harness.registry.snapshot.leases.map((lease) => lease.requesterId),
      outcome: waitingOutcome.state,
      storedRequestStates: harness.registry
        .leaseRequests()
        .map((record) => [record.requesterId, record.state]),
    }).toEqual({
      callerError: undefined,
      storedRequestStates: [
        ["holder", "granted"],
        ["waiter", "granted"],
      ],
      deadlineFellDueDuringTheGrantWrite: true,
      deviceStates: ["deleted", "leased"],
      leaseRequesters: ["waiter"],
      outcome: "fulfilled",
    });
    const granted = await waiting;
    expect(granted).toMatchObject({ lease: { requesterId: "waiter" } });
    expect(granted.device.id).not.toBe(held.device.id);
  });

  it.each(["ready", "booted", "provisioned"] as const)(
    "defers a waiter whose grant of the %s device failed to store and grants it on the next wake",
    async (path) => {
      const harness = await createHarness();
      // why: the booted and provisioned paths funnel through the coordinator's one handoff
      // grant; pinning only the ready one would leave those grants free to orphan their waiter.
      if (path === "ready") await seedReady(harness);
      if (path === "booted") await seedShutdown(harness);
      let failing = true;
      // why: the grant is one registry commit, so failing the commit that stores this waiter's
      // lease is how a dead disk looks to the coordinator; the registry keeps its old state.
      inspectCommits(harness, ({ leaseRequesters }) => {
        if (failing && leaseRequesters.includes("orphaned")) {
          throw new Error("state write refused");
        }
      });

      const acquisition = harness.coordinator.request(request, {
        ownerId: "orphaned",
        requesterId: "orphaned",
      });
      const outcome = promiseState(acquisition);
      await settle();

      const [device] = harness.registry.snapshot.devices;
      expect(device).toBeDefined();
      expect({
        deviceStates: harness.registry.snapshot.devices.map((candidate) => candidate.state),
        leaseRequesters: harness.registry.snapshot.leases.map((lease) => lease.requesterId),
        outcome: outcome.state,
        queueDepth: harness.coordinator.queueDepth,
        storedRequestStates: harness.registry
          .leaseRequests()
          .map((record) => [record.requesterId, record.state]),
      }).toEqual({
        deviceStates: ["ready"],
        leaseRequesters: [],
        outcome: "pending",
        queueDepth: 1,
        storedRequestStates: [["orphaned", "open"]],
      });

      failing = false;
      harness.coordinator.kick();
      await expect(acquisition).resolves.toMatchObject({ device: { id: device?.id } });
    },
  );

  it("performs no provisioning for a waiter the queue times out during its eviction", async () => {
    let deadlineDue = false;
    const harness = await createHarness({
      // why: Fallow does not follow the type through the imported harness, and reports dispose unused.
      lifecycle: (lifecycle: ManagedDeviceLifecycle) => ({
        bootForLease: (...args) => lifecycle.bootForLease(...args),
        rebootForLease: (...args) => lifecycle.rebootForLease(...args),
        dispose: (...args) => {
          // why: an eviction is the waiter's own device work, so this is where a real one spends
          // the seconds its `timeoutMs` covers. The clock moves here to land the armed deadline
          // inside the attempt, which the queue's mid-attempt rule leaves un-rejected; the
          // decision that follows the eviction is what finds the waiter past that deadline.
          if (!deadlineDue) {
            deadlineDue = true;
            harness.clock.advance(30);
          }
          return lifecycle.dispose(...args);
        },
        shutdown: (...args) => lifecycle.shutdown(...args),
        destroy: (...args) => lifecycle.destroy(...args),
      }),
    });
    // why: the one device slot holds a device of another model, so the request can only be served
    // by evicting it. It is leased first, so the request is queued before it is ever planned: only
    // a queued waiter has an armed deadline for the eviction to spend.
    const oldDevice = await seedReady(harness, { ...request, model: "iPhone SE" });
    const held = await harness.coordinator.request(
      { ...request, model: "iPhone SE" },
      { ownerId: "holder", requesterId: "holder" },
    );
    const acquisition = harness.coordinator.request(request, {
      ownerId: "late",
      requesterId: "late",
      timeoutMs: 20,
    });
    void acquisition.catch(() => undefined);
    await settle();
    expect(harness.coordinator.queueDepth).toBe(1);

    // why: the lease ends without a reclaim, so the device stays `ready`, still of the old model:
    // what the queued request evicts. The waiter's budget is 20 ms and the clock stands at 1_000,
    // so the advance inside the eviction takes the deadline with it.
    await harness.registry.beginRelease(held.lease.id);
    await harness.registry.transitionDevice(oldDevice.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: oldDevice.id, duration: 0, strategy: "wipe" },
    });
    harness.coordinator.kick();
    await settle();

    await expect(acquisition).rejects.toMatchObject({ name: "QueueTimeoutError" });
    expect({
      createdModels: harness.driver.calls
        .filter((call) => call.operation === "provision")
        .map((call) => (call.arguments[0] as { readonly model?: string }).model),
      deviceStates: harness.registry.snapshot.devices.map((candidate) => candidate.state),
    }).toEqual({
      createdModels: ["iPhone SE"],
      deviceStates: ["deleted"],
    });
    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "next",
        requesterId: "next",
      }),
    ).resolves.toMatchObject({ device: { spec: { model: "iPhone 16" } } });
  });

  it.each([
    {
      limits: { maxDevices: 1, maxRunning: 1 },
      seed: "ready" as const,
      victim: request,
      work: "grant a ready device",
    },
    {
      limits: { maxDevices: 1, maxRunning: 1 },
      seed: "shutdown" as const,
      victim: request,
      work: "boot a shut-down device",
    },
    {
      limits: { maxDevices: 1, maxRunning: 1 },
      seed: "ready" as const,
      victim: { ...request, model: "iPhone SE" },
      work: "delete an idle device",
    },
    {
      limits: { maxDevices: 2, maxRunning: 1 },
      seed: "ready" as const,
      victim: { ...request, model: "iPhone SE" },
      work: "shut down an idle running device",
    },
  ])(
    "does not go on to $work when the queue will not put the plan in flight",
    async ({ limits, seed, victim }) => {
      const harness = await createHarness(limits);
      if (seed === "shutdown") {
        await seedShutdown(harness, victim);
      } else {
        await seedReady(harness, victim);
      }
      const markProcessing = harness.queue.markProcessing.bind(harness.queue);
      let markedProcessingCalls = 0;
      let refuses = true;
      // why: the queue refuses to put a waiter past its deadline in flight (its own rule, proved
      // in wait-queue.test.ts), and the refusal can land on any plan the coordinator performs.
      // The test above drives one plan kind through a real timeout; the stub stands at each of the
      // others, where the state a real refusal needs is one the queue's own re-queue path creates.
      harness.queue.markProcessing = (waiter) => {
        markedProcessingCalls += 1;
        return refuses ? false : markProcessing(waiter);
      };

      const acquisition = harness.coordinator.request(request, {
        ownerId: "refused",
        requesterId: "refused",
      });
      const outcome = promiseState(acquisition);
      await settle();

      expect({
        deviceStates: harness.registry.snapshot.devices.map((candidate) => candidate.state),
        leaseRequesters: harness.registry.snapshot.leases.map((lease) => lease.requesterId),
        markedProcessingCalls,
        outcome: outcome.state,
        queueDepth: harness.coordinator.queueDepth,
        storedRequestStates: harness.registry
          .leaseRequests()
          .map((record) => [record.requesterId, record.state]),
      }).toEqual({
        deviceStates: [seed === "shutdown" ? "shutdown" : "ready"],
        leaseRequesters: [],
        markedProcessingCalls: 1,
        outcome: "pending",
        queueDepth: 0,
        storedRequestStates: [["refused", "open"]],
      });

      // why: the refused plan gave back the capacity or device claim it held, so the next request
      // is served rather than told the worker is full.
      refuses = false;
      await expect(
        harness.coordinator.request(request, {
          noWait: true,
          ownerId: "next",
          requesterId: "next",
        }),
      ).resolves.toMatchObject({ device: { spec: { model: "iPhone 16" } } });
    },
  );

  it("keeps admission closed until concurrent maintenance callers have all finished", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    await harness.coordinator.beginMaintenance();
    await harness.coordinator.endMaintenance();

    await expect(
      harness.coordinator.request(request, {
        ownerId: "still-maintained",
        requesterId: "still-maintained",
      }),
    ).rejects.toMatchObject({ name: "NukeCancelledError" });

    await harness.coordinator.endMaintenance();
    await expect(
      harness.coordinator.request(request, {
        ownerId: "reopened",
        requesterId: "reopened",
      }),
    ).resolves.toMatchObject({ lease: { ownerId: "reopened", requesterId: "reopened" } });
  });
});
