import { describe, expect, it, vi } from "vitest";

import { FakeClock, JsonLinesLogger, type Logger, MemoryLogSink } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { promiseState } from "../test-support/promise-state.js";
import {
  capacityDevice,
  capacityDevices,
  DriverCrashError,
  type DeviceMode,
  type VirtualSpec,
  specMode,
  type ManagedDeviceLifecycle,
} from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import { IdempotencyConflictError, LeaseRequestForbiddenError } from "./lease-request-book.js";
import { RequesterAlreadyLeasedError } from "./wait-queue.js";
import {
  request,
  createHarness,
  seedReady,
  flush,
  settle,
  seedShutdown,
} from "./test-lease-acquisition.js";

interface StoredByCommit {
  readonly leaseRequesters: readonly string[];
  readonly requestRequesters: readonly string[];
}

/**
 * why: runs `inspect` inside every registry commit, once its rows are written and before it commits: it
 * sees what the commit stores, and throwing from it rolls that commit back.
 */
function inspectCommits(
  harness: { readonly state: StateDatabase },
  inspect: (stored: StoredByCommit) => void,
): void {
  const original = harness.state.transaction.bind(harness.state);
  vi.spyOn(harness.state, "transaction").mockImplementation((work) =>
    original(() => {
      const result = work();
      const requesters = (table: string) =>
        harness.state.database
          .prepare(`SELECT requester_id FROM ${table}`)
          .all()
          .map((row) => String(row["requester_id"]));
      inspect({
        leaseRequesters: requesters("leases"),
        requestRequesters: requesters("lease_requests"),
      });
      return result;
    }),
  );
}

function capturingLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }), sink };
}

// why: drives the coordinator on its own, so a test can interleave its lifecycle, queue and clock in orders the leasing surface cannot force.
describe("LeaseAcquisitionCoordinator", () => {
  it("prepares a warm device before granting when its driver requires it", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    Object.defineProperty(harness.driver, "rebootReadyBeforeGrant", { value: true });
    const ready = vi.spyOn(harness.driver, "makeReady");
    const grant = await harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });
    expect(grant.device.id).toBe(device.id);
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
    expect(harness.queue.hasPendingRequester("agent")).toBe(true);
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
    expect(harness.queue.depth).toBe(1);

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
    expect(harness.queue.depth).toBe(1);
  });

  it.each([["provisioned"], ["ready"]] as const)(
    "hands the owning driver's lease environment to a %s device's grant",
    async (path) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        leaseEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
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

      expect(granted.environment).toEqual({
        SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios",
      });
    },
  );

  it("grants a device from a driver contributing nothing an empty environment", async () => {
    const harness = await createHarness();

    const granted = await harness.coordinator.request(request, {
      ownerId: "agent",
      requesterId: "agent",
    });

    expect(granted.environment).toEqual({});
  });

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

  describe("device mode", () => {
    /** A driver that slims 26.5 and cannot slim 17.5, like iOS on either side of 18.5. */
    function slimmingDriver(options: { readonly mode?: DeviceMode } = {}): FakeDriver {
      return new FakeDriver({
        availableOsVersions: ["17.5", "26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
        slimmableOsVersions: ["26.5"],
        ...options,
      });
    }

    const owner = (id: string) => ({ ownerId: id, requesterId: id });

    it.each([
      ["full", "no mode", undefined, "full"],
      ["slim", "no mode", undefined, "slim"],
      ["full", "mode slim", "slim", "slim"],
      ["slim", "mode full", "full", "full"],
    ] as const)(
      "on a worker whose default is %s, a request with %s gets that device mode",
      async (defaultMode, _label, mode, planned) => {
        const harness = await createHarness({
          defaultModes: { ios: defaultMode },
          drivers: [slimmingDriver()],
        });

        const granted = await harness.coordinator.request(
          { ...request, ...(mode === undefined ? {} : { mode }) },
          owner("agent"),
        );

        expect(specMode(granted.device.spec)).toBe(planned);
        expect(granted.device.mode).toBe(planned);
      },
    );

    it.each([
      ["slim", "slim", true],
      ["slim", "full", false],
      ["full", "full", true],
      ["full", "slim", false],
    ] as const)(
      "on a worker whose default is %s, a device whose pool mode is %s reports servesDefaultMode %s",
      async (defaultMode, poolMode, served) => {
        const harness = await createHarness({
          defaultModes: { ios: defaultMode },
          drivers: [slimmingDriver()],
        });
        const spec = {
          physical: false as const,
          model: "iPhone 17",
          osVersion: "26.5",
          platform: "ios" as const,
          ...(poolMode === "slim" ? { mode: "slim" as const } : {}),
        };

        expect(harness.coordinator.servesDefaultMode(spec)).toBe(served);
      },
    );

    it("compares a device's pool mode with its own platform's default, full when that platform has none", async () => {
      const harness = await createHarness({
        defaultModes: { ios: "slim" },
        drivers: [slimmingDriver()],
      });
      const android = {
        physical: false as const,
        model: "Pixel 9",
        osVersion: "35",
        platform: "android" as const,
      };

      expect(harness.coordinator.servesDefaultMode(android)).toBe(true);
      expect(harness.coordinator.servesDefaultMode({ ...android, mode: "slim" })).toBe(false);
    });

    it.each(["ios", "android"] as const)(
      "reports servesDefaultMode false for a physical spec on %s, though it names no mode and the platform's default is full",
      async (platform) => {
        const harness = await createHarness({ defaultModes: { [platform]: "full" } });

        expect(
          harness.coordinator.servesDefaultMode({
            class: "phone",
            model: "Some Phone",
            osVersion: "1",
            physical: true,
            platform,
          }),
        ).toBe(false);
      },
    );

    it("passes the resolved mode to resolveSpec, the default filled in for a request that named none", async () => {
      const driver = slimmingDriver();
      const harness = await createHarness({ defaultModes: { ios: "slim" }, drivers: [driver] });

      await harness.coordinator.request(request, owner("agent"));

      const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolved?.arguments[0]).toMatchObject({ mode: "slim" });
    });

    it("never plans a full request onto a slim spec, even when the driver's resolveSpec returns one", async () => {
      class AlwaysSlimDriver extends FakeDriver {
        override async resolveSpec(
          ...args: Parameters<FakeDriver["resolveSpec"]>
        ): Promise<VirtualSpec> {
          return { ...(await super.resolveSpec(...args)), mode: "slim" };
        }
      }
      const driver = new AlwaysSlimDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      const harness = await createHarness({ drivers: [driver] });

      const granted = await harness.coordinator.request(
        { ...request, mode: "full" },
        owner("agent"),
      );

      expect(granted.device.spec).not.toHaveProperty("mode");
      const provisioned = driver.calls.find((call) => call.operation === "provision");
      expect(provisioned?.arguments[0]).not.toHaveProperty("mode");
    });

    it.each([
      { name: "full request an idle slim", seeded: "slim", requested: "full" },
      { name: "slim request an idle full", seeded: "full", requested: "slim" },
    ] as const)(
      "does not give a $name device of the same model and runtime",
      async ({ seeded, requested }) => {
        const harness = await createHarness({ drivers: [slimmingDriver()], maxDevices: 2 });
        const idle = await seedReady(
          harness,
          seeded === "slim" ? { ...request, mode: "slim" } : request,
        );

        const granted = await harness.coordinator.request(
          { ...request, mode: requested },
          owner("agent"),
        );

        expect(granted.device.id).not.toBe(idle.id);
        expect(granted.device.mode).toBe(requested);
      },
    );

    it("resolves a slim request on a runtime the driver cannot slim to the full spec, reusing an idle full device", async () => {
      const oldRuntime = { ...request, osVersion: "17.5" };
      const harness = await createHarness({ drivers: [slimmingDriver()] });
      const full = await seedReady(harness, oldRuntime);

      const granted = await harness.coordinator.request(
        { ...oldRuntime, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(full.id);
      expect(granted.device.spec).toEqual(oldRuntime);
      expect(granted.device.mode).toBe("full");
    });

    it("grants a slim request against a driver that knows nothing of modes a full device", async () => {
      const harness = await createHarness();

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.spec).toEqual(request);
      expect(granted.device.mode).toBe("full");
    });

    it("grants a slim-spec device whose slim pass failed as full, and keeps it in the slim pool", async () => {
      const harness = await createHarness({ drivers: [slimmingDriver({ mode: "full" })] });

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.mode).toBe("full");
      expect(granted.device.spec).toEqual({ ...request, mode: "slim" });
    });
  });

  it("A failed eviction shutdown logs the device id and the error, and the waiter is deferred as before.", async () => {
    const { logger, sink } = capturingLogger();
    // Two devices allowed but only one running: a running device of another spec is
    // evicted by shutdown (not deleted) to make room for the request.
    const harness = await createHarness({ logger, maxDevices: 2 });
    const victim = await seedReady(harness, { ...request, model: "iPhone SE" });
    harness.driver.failOn("shutdown", 1, new DriverCrashError("shutdown wedged"));

    let settled = false;
    const acquisition = harness.coordinator.request(request, {
      ownerId: "evictor",
      requesterId: "evictor",
    });
    void acquisition.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.lease-acquisition-coordinator",
        fields: {
          deviceId: victim.id,
          error: "DriverCrashError: shutdown wedged",
          requesterId: "evictor",
          step: "shutdown",
        },
      }),
    ]);
    // Deferred: back in the queue, still pending, and the victim untouched.
    expect(settled).toBe(false);
    expect(harness.coordinator.queueDepth).toBe(1);
    expect(harness.registry.snapshot.devices.find((device) => device.id === victim.id)?.state).toBe(
      "ready",
    );
    await harness.coordinator.cancelPending("evictor");
    await expect(acquisition).rejects.toMatchObject({ name: "RequestCancelledError" });
  });

  it("A failed eviction delete logs the device id and the error.", async () => {
    const { logger, sink } = capturingLogger();
    // One device allowed: a managed device of another spec is deleted to make room.
    const harness = await createHarness({ logger, maxDevices: 1 });
    const victim = await seedShutdown(harness, { ...request, model: "iPhone SE" });
    harness.driver.failOn("destroy", 1, new DriverCrashError("simctl delete refused"));

    const acquisition = harness.coordinator.request(request, {
      ownerId: "evictor",
      requesterId: "evictor",
    });
    await settle();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: victim.id,
          error: "DriverCrashError: simctl delete refused",
          requesterId: "evictor",
          step: "delete",
        },
      }),
    ]);
    await harness.coordinator.cancelPending("evictor");
    await expect(acquisition).rejects.toMatchObject({ name: "RequestCancelledError" });
  });

  it("A failed destroy after a shut-down device fails to boot for a waiter logs the device id and the error.", async () => {
    const { logger, sink } = capturingLogger();
    const harness = await createHarness({ logger });
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({
      name: "BootTimeoutError",
      message: expect.stringContaining("simulator never booted"),
    });

    expect(sink.records.filter((record) => record.fields?.["step"] === "destroy")).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: shutdown.id,
          error: "DriverCrashError: simulator would not die",
          requesterId: "booter",
          step: "destroy",
        },
      }),
    ]);
  });

  it("A shut-down device that fails to boot for a waiter and then fails to be destroyed is quarantined and counts once against running capacity.", async () => {
    // why: two running slots — the failed device's and the one a second request needs.
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const shutdown = await seedShutdown(harness);
    // why: call 1 is seedShutdown's own boot; call 2 is the waiter's.
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });
    await settle();

    expect(
      harness.registry.snapshot.devices.find((device) => device.id === shutdown.id)?.state,
    ).toBe("quarantined");
    // why: `quarantined` already counts as running — a reservation still held would count
    // this device twice and refuse the second slot.
    await expect(
      harness.coordinator.request(
        { ...request, model: "iPhone SE" },
        { noWait: true, ownerId: "second", requesterId: "second" },
      ),
    ).resolves.toMatchObject({ device: { spec: { model: "iPhone SE" }, state: "leased" } });
  });

  it("grants a request that arrives while a failed boot's device is being destroyed a device of its own, without waiting for the destroy.", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const shutdownId = (await seedShutdown(harness)).id;
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    let failDestroy: (error: Error) => void = () => undefined;
    const realDestroy = harness.driver.destroy.bind(harness.driver);
    let destroys = 0;
    vi.spyOn(harness.driver, "destroy").mockImplementation(async (device) => {
      destroys += 1;
      if (destroys > 1) return realDestroy(device);
      return new Promise<void>((_resolve, reject) => {
        failDestroy = reject;
      });
    });

    const booter = harness.coordinator.request(request, {
      ownerId: "booter",
      requesterId: "booter",
    });
    const booterOutcome = booter.catch((error: unknown) => error);
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondGranted = false;
    void second.then(() => {
      secondGranted = true;
    });
    await settle();

    expect(secondGranted).toBe(true);
    expect((await second).device.id).not.toBe(shutdownId);

    failDestroy(new DriverCrashError("simulator would not die"));
    await booterOutcome;
  });

  it("A device whose boot for a waiter failed is deleted by the lease engine, and its slot is freed.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(harness.bus.replay().filter((event) => event.event === "device.deleted")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ deviceId: shutdown.id, initiator: "lease-engine" }),
      }),
    ]);
    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "second",
        requesterId: "second",
      }),
    ).resolves.toMatchObject({ lease: { requesterId: "second" } });
  });

  it("A failed boot whose device the destroy can no longer claim frees the waiter's running slot and leaves no fence.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    const realMakeReady = harness.driver.makeReady.bind(harness.driver);
    let failedBoots = 0;
    vi.spyOn(harness.driver, "makeReady").mockImplementation(async (...args) => {
      try {
        return await realMakeReady(...args);
      } finally {
        failedBoots += 1;
        // The record leaves `shutdown` while the boot fails, so the destroy finds nothing to claim.
        if (failedBoots === 1) {
          await harness.registry.transitionDevice(shutdown.id, "deleted", {
            event: "device.deleted",
            payload: { deviceId: shutdown.id, initiator: "test" },
          });
        }
      }
    });

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "second",
        requesterId: "second",
      }),
    ).resolves.toMatchObject({ lease: { requesterId: "second" } });
  });

  it.each([
    ["answers that another operation owns the device", async (): Promise<boolean> => false],
    ["throws", async (): Promise<boolean> => Promise.reject(new Error("state write failed"))],
  ] as const)(
    "A failed boot whose destroy throws frees the waiter's running slot and leaves no fence, even when quarantine %s.",
    async (_label, enterFromStalledTransition) => {
      const harness = await createHarness({
        lifecycle: (lifecycle) => ({
          bootForLease: (device, claim) => lifecycle.bootForLease(device, claim),
          rebootForLease: (...args) => lifecycle.rebootForLease(...args),
          dispose: (...args) => lifecycle.dispose(...args),
          shutdown: (...args) => lifecycle.shutdown(...args),
          destroy: () => Promise.reject(new DriverCrashError("simulator would not delete")),
        }),
        quarantine: { enterFromStalledTransition },
      });
      const shutdown = await seedShutdown(harness);
      harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

      await expect(
        harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
      ).rejects.toMatchObject({ name: "BootTimeoutError" });
      await settle();

      await expect(
        harness.coordinator.request(request, { ownerId: "second", requesterId: "second" }),
      ).resolves.toMatchObject({ device: { id: shutdown.id, state: "leased" } });
    },
  );

  it("releases the running slot reserved to boot a shut-down device for a waiter when the boot fails and another boot claims the device before it is destroyed", async () => {
    // The warm pool's boot reserves its own slot and claims the device in one decision. Here it
    // lands after the failed boot has released its claim and before the destroy claims the device.
    let raced = false;
    let warmBoot: { release(): void } | undefined;
    const harness = await createHarness({
      maxDevices: 2,
      maxRunning: 2,
      lifecycle: (lifecycle, { capacity, claims, registry }) => ({
        bootForLease: (device, claim) => lifecycle.bootForLease(device, claim),
        rebootForLease: (...args) => lifecycle.rebootForLease(...args),
        dispose: (...args) => lifecycle.dispose(...args),
        shutdown: (...args) => lifecycle.shutdown(...args),
        destroy: (device, initiator, operation, claim) => {
          const reservation = capacity.tryReserveBoot(
            capacityDevice(device),
            capacityDevices(registry.snapshot.virtualDevices),
          );
          const warmClaim = claims.tryClaim(device.id, "boot");
          raced = reservation.ok && warmClaim !== undefined;
          warmBoot = {
            release: () => {
              warmClaim?.release();
              if (reservation.ok) reservation.reservation.release();
            },
          };
          return lifecycle.destroy(device, initiator, operation, claim);
        },
      }),
    });
    await seedShutdown(harness);
    // Call 1 is seedShutdown's own boot; call 2 is the waiter's.
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });
    expect(raced).toBe(true);

    // The warm pool's boot ends and gives back its own claim and slot.
    warmBoot?.release();
    await settle();

    for (const requester of ["first", "second"]) {
      await expect(
        harness.coordinator.request(request, {
          noWait: true,
          ownerId: requester,
          requesterId: requester,
        }),
      ).resolves.toMatchObject({ lease: { requesterId: requester } });
    }
  });
});

describe("LeaseAcquisitionCoordinator stored requests", () => {
  const keyed = { idempotencyKey: "key-1", ownerId: "agent", requesterId: "agent" } as const;

  /** Grants the one device capacity allows to `holder`, then frees it again on demand. */
  async function holdTheOnlyDevice(harness: Awaited<ReturnType<typeof createHarness>>) {
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    return async () => {
      await harness.registry.beginRelease(held.lease.id);
      await harness.registry.transitionDevice(held.device.id, "ready", {
        event: "device.reclaimed",
        payload: { deviceId: held.device.id, duration: 0, strategy: "wipe" },
      });
      harness.coordinator.kick();
      await flush();
    };
  }

  it("returns the first result to a repeated request under the same key and grants no second lease", async () => {
    const harness = await createHarness();
    const first = await harness.coordinator.request(request, keyed);

    const second = await harness.coordinator.request(request, keyed);

    expect(second.lease.id).toBe(first.lease.id);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });

  it("attaches a repeat of an open request to the existing wait instead of starting a second one", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    const first = harness.coordinator.request(request, keyed);
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);

    const repeat = harness.coordinator.request(request, keyed);
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);
    expect(
      harness.registry.leaseRequests().filter((record) => record.requesterId === "agent"),
    ).toHaveLength(1);

    await free();
    const [granted, repeated] = await Promise.all([first, repeat]);
    expect(repeated.lease.id).toBe(granted.lease.id);
  });

  it("tells a repeat joining an open wait where that wait stands now", async () => {
    const harness = await createHarness();
    await holdTheOnlyDevice(harness);
    void harness.coordinator.request(request, keyed).catch(() => undefined);
    await flush();

    const heard: unknown[] = [];
    void harness.coordinator
      .request(request, { ...keyed, onProgress: (progress) => heard.push(progress) })
      .catch(() => undefined);
    await flush();

    expect(heard).toEqual([{ queuePosition: 1, stage: "queued" }]);
  });

  it("stores a request before the wait queue sees it", async () => {
    const harness = await createHarness();
    const order: string[] = [];
    inspectCommits(harness, ({ requestRequesters }) => {
      if (requestRequesters.includes("agent") && !order.includes("stored")) order.push("stored");
    });
    const create = harness.queue.create.bind(harness.queue);
    harness.queue.create = (...args) => {
      order.push("queued");
      return create(...args);
    };

    await harness.coordinator.request(request, keyed);

    expect(order.slice(0, 2)).toEqual(["stored", "queued"]);
  });

  it("keeps a capacity failure terminal under the same key after capacity frees up", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    await free();

    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY", name: "ReplayedLeaseRequestError" });
    expect(harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("starts a fresh request for a new key once the prior one is terminal", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    await free();

    const granted = await harness.coordinator.request(request, {
      ...keyed,
      idempotencyKey: "key-2",
    });

    expect(granted.lease.requesterId).toBe("agent");
    // The grant and its stored result land in one commit; the flush lets the wait settle.
    await flush();
    expect(harness.registry.leaseRequests().map((record) => record.state)).toEqual([
      "granted",
      "failed",
      "granted",
    ]);
  });

  it("refuses the same key naming a different device as an idempotency conflict", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, keyed);

    await expect(
      harness.coordinator.request({ ...request, model: "iPhone 17" }, keyed),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("refuses a repeat sent by a different principal", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, keyed);

    await expect(
      harness.coordinator.request(request, { ...keyed, ownerId: "someone-else" }),
    ).rejects.toBeInstanceOf(LeaseRequestForbiddenError);
  });

  it("stores one record for two concurrent requests under one key", async () => {
    const harness = await createHarness();

    const [first, second] = await Promise.all([
      harness.coordinator.request(request, keyed),
      harness.coordinator.request(request, keyed),
    ]);

    expect(harness.registry.leaseRequests()).toHaveLength(1);
    expect(second.lease.id).toBe(first.lease.id);
  });

  it("stores a request that carries no idempotency key, and names it on lease.requested", async () => {
    const harness = await createHarness();

    await harness.coordinator.request(request, { ownerId: "agent", requesterId: "agent" });
    await flush();

    expect(harness.registry.leaseRequests()).toMatchObject([
      { requesterId: "agent", state: "granted" },
    ]);
    const [stored] = harness.registry.leaseRequests();
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.requested")
        .map((event) => event.payload),
    ).toMatchObject([{ requestId: stored?.id, requester: "agent" }]);
    expect(harness.registry.leaseRequests()[0]).not.toHaveProperty("idempotencyKey");
  });
});

describe("LeaseAcquisitionCoordinator: what lease.granted reports", () => {
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  function granted(harness: Awaited<ReturnType<typeof createHarness>>) {
    const events: Array<{ requestId: string; source: string; leaseId: string }> = [];
    harness.bus.subscribe("lease.granted", (envelope) => events.push(envelope.payload));
    const requested: string[] = [];
    harness.bus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    return { events, requested };
  }

  it.each([
    {
      name: "warm for a lease granted from a ready device",
      source: "warm",
      seed: async (harness) => {
        await seedReady(harness);
      },
    },
    {
      name: "booted for a lease granted after booting a shut-down device",
      source: "booted",
      seed: async (harness) => {
        await seedShutdown(harness);
      },
    },
    {
      name: "provisioned for a lease granted on a device provisioned for it",
      source: "provisioned",
      seed: async () => undefined,
    },
    {
      name: "provisioned when an eviction deleted a device and a new one was created",
      source: "provisioned",
      seed: async (harness) => {
        await seedReady(harness, { ...request, model: "iPhone SE" });
      },
    },
    {
      // why: with one running slot taken by a ready device of another model, the shut-down device
      // of the requested model can boot only after an eviction gives the slot back.
      name: "booted when an eviction shut a device down and a shut-down device was then booted",
      source: "booted",
      limits: { maxDevices: 2, maxRunning: 1 },
      seed: async (harness) => {
        await seedShutdown(harness);
        return seedReady(harness, { ...request, model: "iPhone SE" });
      },
      evictedLeavesReady: true,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    source: "warm" | "booted" | "provisioned";
    limits?: { maxDevices: number; maxRunning: number };
    seed: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<{ id: string } | void>;
    evictedLeavesReady?: boolean;
  }>)(
    "emits lease.granted with exactly the grant's device, lease, requester, request and platform, and source $name",
    async ({ source, limits, seed, evictedLeavesReady }) => {
      const harness = await createHarness(limits);
      const evicted = await seed(harness);
      const { events, requested } = granted(harness);

      const grant = await harness.coordinator.request(request, owner("agent"));

      expect(requested[0]).toMatch(/^req_/);
      expect(events).toEqual([
        {
          deviceId: grant.device.id,
          leaseId: grant.lease.id,
          platform: grant.device.spec.platform,
          requester: "agent",
          requestId: requested[0],
          source,
        },
      ]);
      if (evictedLeavesReady === true) {
        expect(
          harness.registry.snapshot.devices.find((device) => device.id === evicted?.id)?.state,
        ).not.toBe("ready");
      }
    },
  );

  it("gives a request refused as already-leased the id its admission would have minted, and emits no lease.requested for it", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const first = await harness.coordinator.request(request, owner("agent"));
    const requested: string[] = [];
    harness.bus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    const rejected: Array<{ requestId: string; requester: string; reason: string }> = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const mintedBefore = harness.requestIds.length;

    await expect(harness.coordinator.request(request, owner("agent"))).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
    });

    expect(requested).toEqual([]);
    expect(harness.requestIds).toHaveLength(mintedBefore + 1);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "already-leased",
        requestId: `req_${harness.requestIds[mintedBefore]}`,
        requester: "agent",
      }),
    ]);

    // The same position in the sequence, on a request that passes admission: that id is the one
    // the stored request gets, and nothing mints a second.
    const mintedBeforeAdmitted = harness.requestIds.length;
    await harness.coordinator.request(request, owner("other"));
    expect(harness.requestIds).toHaveLength(mintedBeforeAdmitted + 1);
    expect(requested).toEqual([`req_${harness.requestIds[mintedBeforeAdmitted]}`]);
  });

  it("gives a request refused as killed the id it would have been stored under", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    const rejected: Array<{ requestId: string; requester: string; reason: string }> = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await expect(harness.coordinator.request(request, owner("agent"))).rejects.toMatchObject({
      name: "NukeCancelledError",
    });

    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "killed",
        requestId: `req_${harness.requestIds[0]}`,
        requester: "agent",
      }),
    ]);
  });
});

describe("LeaseAcquisitionCoordinator probes (ADR 0021)", () => {
  const probe = (requesterId: string) => ({
    fleetRequestId: "req_gw1",
    noWait: true,
    ownerId: requesterId,
    requesterId,
  });

  it("emits lease.declined, and no lease.rejected, for a probe refused killed at admission", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    const declined: unknown[] = [];
    const rejected: unknown[] = [];
    harness.bus.subscribe("lease.declined", (envelope) => declined.push(envelope.payload));
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await expect(harness.coordinator.request(request, probe("gw:one"))).rejects.toMatchObject({
      name: "NukeCancelledError",
    });

    expect(declined).toEqual([
      {
        fleetRequestId: "req_gw1",
        reason: "killed",
        requestId: `req_${harness.requestIds[0]}`,
        requestSpec: request,
        requester: "gw:one",
      },
    ]);
    expect(rejected).toEqual([]);
  });

  it("emits lease.declined, and no lease.rejected, for a probe in progress when beginMaintenance runs", async () => {
    const harness = await createHarness();
    harness.driver.hangMakeReady();
    const declined: unknown[] = [];
    const rejected: unknown[] = [];
    harness.bus.subscribe("lease.declined", (envelope) => declined.push(envelope.payload));
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const acquisition = harness.coordinator.request(request, probe("gw:one"));
    void acquisition.catch(() => undefined);
    await settle();

    const maintenance = harness.coordinator.beginMaintenance();
    await flush();
    harness.driver.releaseMakeReady();
    await maintenance;

    await expect(acquisition).rejects.toMatchObject({ name: "NukeCancelledError" });
    expect(declined).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", reason: "killed", requester: "gw:one" }),
    ]);
    expect(rejected).toEqual([]);
    await harness.coordinator.endMaintenance();
  });
});

describe("LeaseAcquisitionCoordinator waiting demand", () => {
  it("lists a request waiting for a device with what a device must satisfy, and drops it once it is granted", async () => {
    const harness = await createHarness();
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    expect(harness.coordinator.waitingDemand()).toEqual([]);

    const waiting = harness.coordinator.request(request, {
      ownerId: "waiter",
      requesterId: "waiter",
    });
    await flush();

    expect(harness.coordinator.waitingDemand()).toEqual([
      {
        classOf: expect.any(Function),
        inFlight: false,
        mode: "full",
        platform: "ios",
        requirement: {
          imageTag: undefined,
          osVersion: { kind: "exact", version: "26.5" },
          platform: "ios",
          target: { kind: "model", model: "iPhone 16" },
        },
        spec: request,
      },
    ]);

    await harness.registry.beginRelease(held.lease.id);
    await harness.registry.transitionDevice(held.device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: held.device.id, duration: 0, strategy: "wipe" },
    });
    harness.coordinator.kick();
    await waiting;
    expect(harness.coordinator.waitingDemand()).toEqual([]);
  });

  it("reports the mode a request resolved to, and marks a request whose device work has begun as in flight", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 50 },
      platform: "ios",
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({ drivers: [driver] });
    const pending = harness.coordinator.request(
      { ...request, mode: "slim" },
      { ownerId: "slim", requesterId: "slim" },
    );
    await flush();

    expect(harness.coordinator.waitingDemand()).toMatchObject([{ inFlight: true, mode: "slim" }]);

    clock.advance(50);
    await pending;
    expect(harness.coordinator.waitingDemand()).toEqual([]);
  });

  it("reports maintenance active between beginMaintenance and endMaintenance", async () => {
    const harness = await createHarness();
    expect(harness.coordinator.maintenanceActive).toBe(false);

    await harness.coordinator.beginMaintenance();
    expect(harness.coordinator.maintenanceActive).toBe(true);

    await harness.coordinator.endMaintenance();
    expect(harness.coordinator.maintenanceActive).toBe(false);
  });
});

describe("LeaseAcquisitionCoordinator: a request naming a baseline", () => {
  it("plans against the version current at its decision, so a save between the resolve and the plan grants an idle device of the new version", async () => {
    const current = (version: number) => ({
      mode: "full" as const,
      model: request.model,
      name: "checkout",
      osVersion: request.osVersion,
      platform: request.platform,
      sourceId: `source-${version}`,
      version,
    });
    const reads = [current(1)];
    const harness = await createHarness({
      baselines: { current: () => reads.shift() ?? current(2) },
      maxDevices: 2,
    });
    const idleV2 = await seedReady(harness, {
      ...request,
      baseline: { name: "checkout", version: 2 },
    });

    const granted = await harness.coordinator.request(
      { baseline: "checkout", platform: "ios" },
      { ownerId: "agent", requesterId: "agent" },
    );

    expect(granted.device.id).toBe(idleV2.id);
    expect(granted.device.spec.baseline).toEqual({ name: "checkout", version: 2 });
  });

  it("ends a request whose baseline was removed while it waited as UnknownBaselineError at once, without a retry", async () => {
    const harness = await createHarness({
      baselines: {
        current: () => ({
          mode: "full" as const,
          model: request.model,
          name: "checkout",
          osVersion: request.osVersion,
          platform: request.platform,
          sourceId: "source-1",
          version: 1,
        }),
      },
      maxDevices: 1,
    });

    const outcome = await harness.coordinator
      .request(
        { baseline: "checkout", platform: "ios" },
        { ownerId: "agent", requesterId: "agent" },
      )
      .then(
        () => "granted",
        (error: unknown) => (error as Error).name,
      );

    expect(outcome).toBe("UnknownBaselineError");
  });
});
