import { describe, expect, it, vi } from "vitest";
import {
  type DeviceRequest,
  type LeaseGrant,
  type LeaseProgress,
  NoDriverError,
  type Config,
  type MaxPerRequester,
  type PhysicalDevice,
  UnknownModelError,
} from "../core/index.js";
import { FakeDriver, loadTestRegistry, testComponentWiring, testStateOf } from "../core/testing.js";
import { EventBus, type EventMap } from "../bus/index.js";
import { FakeClock, FakeSystemStats } from "../ports/index.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import { createTestEngine } from "./testing.js";
import { QueueTimeoutError, RequestCancelledError } from "./wait-queue.js";

const gibibyte = 1024 ** 3;

const physicalRequest = {
  model: "iPhone 15 Pro",
  physical: true,
  platform: "ios",
} as const satisfies DeviceRequest;

const virtualRequest = {
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
} as const satisfies DeviceRequest;

function config(leaseOverrides: object = {}): Config {
  return {
    capabilities: {},
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
      alerts: { destinations: [] },
    },
    drivers: {},
    downloads: { acceptAndroidLicenses: false, policy: "on-request", timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 100 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    android: {
      defaultModels: {},
      emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
    },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    update: { check: true },
    lease: {
      defaultTtlMs: 3_600_000,
      maxTtlMs: 14_400_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: 600_000,
      ...leaseOverrides,
    },
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
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: {
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    metrics: { retention: 90 * 24 * 60 * 60 * 1000 },
    warmPool: {
      enabled: false,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

async function createHarness(
  options: {
    readonly reclaimEstimateMs?: number;
    readonly lease?: { readonly maxPerRequester?: MaxPerRequester };
  } = {},
) {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    ...(options.reclaimEstimateMs === undefined
      ? {}
      : { estimateMs: { reclaim: options.reclaimEstimateMs } }),
    platform: "ios",
  });
  let nextId = 1;
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => `${nextId++}` },
  });
  const wiring = testComponentWiring({ clock, drivers: [driver], eventBus: bus, registry });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config: config(options.lease),
    drivers: [driver],
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    registry,
    state: testStateOf(registry),
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
  });
  return { bus, clock, decisions: wiring.decisions, driver, engine, registry };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function enrollIphone(harness: Harness, driverDeviceId: string): Promise<PhysicalDevice> {
  const device = await harness.registry.enrollPhysical({
    apps: [],
    class: "phone",
    driverDeviceId,
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    platform: "ios",
  });
  harness.driver.setPhysicalPresence(driverDeviceId, true);
  return device;
}

async function startReclaiming(harness: Harness, device: PhysicalDevice): Promise<void> {
  await harness.registry.transitionDevice(device.id, "leased");
  await harness.registry.transitionDevice(device.id, "reclaiming");
}

async function finishReclaim(harness: Harness, device: PhysicalDevice): Promise<void> {
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.reclaimed",
    payload: { deviceId: device.id, duration: 0, strategy: "uninstall" },
  });
}

function asking(requesterId: string, extra: object = {}) {
  return { ownerId: requesterId, requesterId, ...extra };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    await Promise.resolve();
  }
}

async function outcome(promise: Promise<LeaseGrant>): Promise<LeaseGrant | Error | "pending"> {
  return Promise.race([
    promise.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    flush().then(() => "pending" as const),
  ]);
}

function eventsNamed<Name extends keyof EventMap>(harness: Harness, name: Name) {
  return harness.bus.replay().filter((event) => event.event === name);
}

function stateOf(harness: Harness, device: PhysicalDevice): string | undefined {
  return harness.registry.snapshot.devices.find((candidate) => candidate.id === device.id)?.state;
}

function presenceReads(harness: Harness): unknown[] {
  return harness.driver.calls
    .filter((call) => call.operation === "listPresentPhysical")
    .map((call) => call.arguments[0]);
}

function claimKind(harness: Harness, device: PhysicalDevice): string | undefined {
  return harness.engine.core.claims.claim(device.id)?.kind;
}

async function waiterMidPresenceRead(options: { readonly timeoutMs?: number } = {}) {
  const harness = await createHarness();
  const device = await enrollIphone(harness, "UDID-A");
  await startReclaiming(harness, device);
  harness.driver.holdPresenceReads("UDID-A");
  const promise = harness.engine.request(physicalRequest, asking("agent", options));
  await flush();
  await finishReclaim(harness, device);
  harness.engine.leasing.corePorts.notifyAvailability();
  await flush();
  return { device, harness, promise };
}

async function queuedLines() {
  const harness = await createHarness();
  await enrollIphone(harness, "UDID-A");
  await harness.engine.request(physicalRequest, asking("physical-holder"));
  await harness.engine.request(virtualRequest, asking("virtual-holder"));
  const marker = harness.bus.replay().length;
  void harness.engine.request(physicalRequest, asking("physical-1"));
  void harness.engine.request(physicalRequest, asking("physical-2"));
  void harness.engine.request(virtualRequest, asking("virtual-1"));
  await flush();
  return { harness, marker };
}

describe("createLeasing with physical devices", () => {
  it("ends a physical request for a platform with no driver NO_DRIVER, lease.rejected unresolvable-spec", async () => {
    const harness = await createHarness();

    const result = await outcome(
      harness.engine.request({ ...physicalRequest, platform: "android" }, asking("agent")),
    );

    expect(result).toBeInstanceOf(NoDriverError);
    expect(eventsNamed(harness, "lease.rejected")).toMatchObject([
      { payload: { reason: "unresolvable-spec", requestSpec: { physical: true } } },
    ]);
  });

  it("makes no listCatalog and no resolveSpec call on the fake driver for a physical request, granted or refused", async () => {
    const lookups = (harness: Harness) =>
      harness.driver.calls
        .map((call) => call.operation)
        .filter((operation) => operation === "listCatalog" || operation === "resolveSpec");
    const granting = await createHarness();
    const device = await enrollIphone(granting, "UDID-A");
    const refusing = await createHarness();

    const granted = await outcome(granting.engine.request(physicalRequest, asking("agent")));
    const refused = await outcome(
      refusing.engine.request(
        { class: "tablet", physical: true, platform: "ios" },
        asking("agent"),
      ),
    );

    expect(lookups(granting)).toEqual([]);
    expect(lookups(refusing)).toEqual([]);
    expect(granted).toMatchObject({ device: { id: device.id } });
    expect(refused).toBeInstanceOf(UnknownModelError);
  });

  it("counts a presence read that rejects as not present and releases the grant claim", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.failOn("listPresentPhysical", 1, new Error("adb: device offline"));

    const result = await outcome(
      harness.engine.request(physicalRequest, asking("agent", { noWait: true })),
    );

    expect(result).toBeInstanceOf(NoCapacityError);
    expect(presenceReads(harness)).toEqual([["UDID-A"]]);
    expect(harness.engine.core.claims.isClaimed(device.id)).toBe(false);
    expect(stateOf(harness, device)).toBe("ready");
  });

  it("does not grant a device whose state changed during its presence read, and plans the waiter again", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    harness.driver.holdPresenceReads("UDID-A");

    const promise = harness.engine.request(physicalRequest, asking("agent"));
    await flush();
    expect(claimKind(harness, first)).toBe("grant");
    await harness.registry.transitionDevice(first.id, "leased");
    harness.driver.releasePresenceReads();
    const result = await outcome(promise);

    expect(result).toMatchObject({ device: { id: second.id } });
    expect(presenceReads(harness)).toEqual([["UDID-A"], ["UDID-B"]]);
    expect(stateOf(harness, first)).toBe("leased");
    expect(harness.engine.core.claims.isClaimed(first.id)).toBe(false);
  });

  it("does not let a new physical request take a ready device that an older queued physical request matches", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.setPhysicalPresence("UDID-A", false);
    const older = harness.engine.request(physicalRequest, asking("older"));
    expect(await outcome(older)).toBe("pending");
    harness.driver.setPhysicalPresence("UDID-A", true);

    const newer = await outcome(
      harness.engine.request(physicalRequest, asking("newer", { noWait: true })),
    );

    expect(newer).toBeInstanceOf(NoCapacityError);
    expect(stateOf(harness, device)).toBe("ready");
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("provision");
    harness.engine.leasing.corePorts.notifyAvailability();
    expect(await outcome(older)).toMatchObject({ device: { id: device.id } });
  });

  it("grants a new physical request a ready device that an older physical request also matches while the older one is mid presence read for another device", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    harness.driver.holdPresenceReads("UDID-A");
    const older = harness.engine.request(physicalRequest, asking("older"));
    await flush();
    expect(claimKind(harness, first)).toBe("grant");

    const newer = await outcome(harness.engine.request(physicalRequest, asking("newer")));
    harness.driver.releasePresenceReads();

    expect(newer).toMatchObject({ device: { id: second.id } });
    expect(await outcome(older)).toMatchObject({ device: { id: first.id } });
  });

  it("gives no reclaiming progress stage to a physical waiter whose only match is reclaiming", async () => {
    const harness = await createHarness({ reclaimEstimateMs: 34_000 });
    const device = await enrollIphone(harness, "UDID-A");
    await startReclaiming(harness, device);
    const progress: LeaseProgress[] = [];

    const result = await outcome(
      harness.engine.request(
        physicalRequest,
        asking("agent", { onProgress: (update: LeaseProgress) => progress.push(update) }),
      ),
    );

    expect(result).toBe("pending");
    expect(progress).toEqual([{ queuePosition: 1, stage: "queued" }]);
    expect(stateOf(harness, device)).toBe("reclaiming");
  });

  it("grants both of two queued physical requests that match two devices that become ready at once: two devices, two waiters, one wake", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    await startReclaiming(harness, first);
    await startReclaiming(harness, second);
    const older = harness.engine.request(physicalRequest, asking("older"));
    const newer = harness.engine.request(physicalRequest, asking("newer"));
    await flush();
    await finishReclaim(harness, first);
    await finishReclaim(harness, second);

    harness.engine.leasing.corePorts.notifyAvailability();
    const results = [await outcome(older), await outcome(newer)];

    expect(results).toMatchObject([{ device: { id: first.id } }, { device: { id: second.id } }]);
  });

  it("does not grant a waiter that times out, is cancelled, or is killed by nuke during its presence read: the device stays ready and the grant claim is released", async () => {
    const timedOut = await waiterMidPresenceRead({ timeoutMs: 1_000 });
    expect(claimKind(timedOut.harness, timedOut.device)).toBe("grant");
    timedOut.harness.clock.advance(1_000);
    timedOut.harness.driver.releasePresenceReads();
    expect(await outcome(timedOut.promise)).toBeInstanceOf(QueueTimeoutError);
    expect(stateOf(timedOut.harness, timedOut.device)).toBe("ready");
    expect(timedOut.harness.engine.core.claims.isClaimed(timedOut.device.id)).toBe(false);

    const cancelled = await waiterMidPresenceRead();
    expect(claimKind(cancelled.harness, cancelled.device)).toBe("grant");
    expect(await cancelled.harness.engine.cancelPending("agent")).toBe("cancelled");
    cancelled.harness.driver.releasePresenceReads();
    expect(await outcome(cancelled.promise)).toBeInstanceOf(RequestCancelledError);
    expect(stateOf(cancelled.harness, cancelled.device)).toBe("ready");
    expect(cancelled.harness.engine.core.claims.isClaimed(cancelled.device.id)).toBe(false);

    const killed = await waiterMidPresenceRead();
    expect(claimKind(killed.harness, killed.device)).toBe("grant");
    const nuking = killed.harness.engine.nuke(false);
    expect(await outcome(killed.promise)).toMatchObject({ name: "NukeCancelledError" });
    killed.harness.driver.releasePresenceReads();
    await nuking;
    expect(killed.harness.registry.snapshot.leases).toEqual([]);
    expect(stateOf(killed.harness, killed.device)).toBe("ready");
    expect(killed.harness.engine.core.claims.isClaimed(killed.device.id)).toBe(false);
  });

  it("wakes the queue after a grant: a queued physical request that no wake reached since a second device became ready is granted it", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    await startReclaiming(harness, first);
    await startReclaiming(harness, second);
    harness.driver.holdPresenceReads("UDID-A");
    const older = harness.engine.request(physicalRequest, asking("older"));
    const newer = harness.engine.request(physicalRequest, asking("newer"));
    await flush();
    await finishReclaim(harness, first);
    harness.engine.leasing.corePorts.notifyAvailability();
    await flush();
    await finishReclaim(harness, second);

    harness.driver.releasePresenceReads();

    expect(await outcome(older)).toMatchObject({ device: { id: first.id } });
    expect(await outcome(newer)).toMatchObject({ device: { id: second.id } });
  });

  it("drives every queued physical waiter on one wake, so a newer waiter is granted its ready device while an older one still waits for another model", async () => {
    const harness = await createHarness();
    const wanted = await enrollIphone(harness, "UDID-A");
    const other = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-B",
      model: "iPhone 13",
      osVersion: "18.4",
      platform: "ios",
    });
    harness.driver.setPhysicalPresence("UDID-B", true);
    await harness.registry.transitionDevice(other.id, "leased");
    await startReclaiming(harness, wanted);
    const older = harness.engine.request(
      { ...physicalRequest, model: "iPhone 13" },
      asking("older"),
    );
    const newer = harness.engine.request(physicalRequest, asking("newer"));
    await flush();
    await finishReclaim(harness, wanted);

    harness.engine.leasing.corePorts.notifyAvailability();

    expect(await outcome(newer)).toMatchObject({ device: { id: wanted.id } });
    expect(await outcome(older)).toBe("pending");
  });

  it("grants the next queued physical request the device that a cancelled waiter held a grant claim on during its presence read", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.holdPresenceReads("UDID-A");
    const cancelled = harness.engine.request(physicalRequest, asking("cancelled"));
    await flush();
    expect(claimKind(harness, device)).toBe("grant");
    const next = harness.engine.request(physicalRequest, asking("next"));
    await flush();

    expect(await harness.engine.cancelPending("cancelled")).toBe("cancelled");
    harness.driver.releasePresenceReads();

    expect(await outcome(cancelled)).toBeInstanceOf(RequestCancelledError);
    expect(await outcome(next)).toMatchObject({ device: { id: device.id } });
  });

  it("cancelling a queued physical request makes the one held for it plan again and list its own reason", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    const blocker = harness.engine.core.claims.tryClaim(device.id, "boot", "blocker");
    expect(blocker).toBeDefined();
    const older = harness.engine.request(physicalRequest, asking("older"));
    void harness.engine.request(physicalRequest, asking("newer"));
    await flush();
    expect(harness.engine.waitingRequests()).toMatchObject([
      { reason: "no-free-physical", requesterId: "older", stage: "queued" },
      { reason: "behind-earlier-request", requesterId: "newer", stage: "queued" },
    ]);

    expect(await harness.engine.cancelPending("older")).toBe("cancelled");
    await flush();

    expect(await outcome(older)).toBeInstanceOf(RequestCancelledError);
    expect(harness.engine.waitingRequests()).toMatchObject([
      { reason: "no-free-physical", requesterId: "newer", stage: "queued" },
    ]);
  });

  it("lists no reason for a physical request held in its presence read", async () => {
    const { harness } = await waiterMidPresenceRead();

    expect(harness.engine.waitingRequests()).toMatchObject([
      { requesterId: "agent", stage: "starting" },
    ]);
    expect(harness.engine.waitingRequests()[0]).not.toHaveProperty("reason");
  });

  it("releases the grant claim, leaves the device ready, keeps the waiter queued and says no-free-physical when the lease write of a physical grant throws", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    const createLease = vi
      .spyOn(harness.registry, "createLease")
      .mockRejectedValueOnce(new Error("disk full"));

    const result = await outcome(harness.engine.request(physicalRequest, asking("agent")));
    await flush();

    expect(createLease).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id }));
    expect(result).toBe("pending");
    expect(harness.engine.physicalQueueDepth).toBe(1);
    expect(harness.engine.core.claims.isClaimed(device.id)).toBe(false);
    expect(stateOf(harness, device)).toBe("ready");
    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(harness.engine.waitingRequests()).toMatchObject([
      { reason: "no-free-physical", requesterId: "agent", stage: "queued" },
    ]);
  });

  it("a physical lease counts toward lease.maxPerRequester like a virtual one", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: 2 } });
    await enrollIphone(harness, "UDID-A");

    await expect(harness.engine.request(physicalRequest, asking("agent-1"))).resolves.toMatchObject(
      { lease: { id: expect.any(String) } },
    );
    await expect(harness.engine.request(virtualRequest, asking("agent-1"))).resolves.toMatchObject({
      lease: { id: expect.any(String) },
    });
    const third = await outcome(harness.engine.request(virtualRequest, asking("agent-1")));

    expect(third).toMatchObject({ name: "RequesterAlreadyLeasedError" });
  });

  it("a physical iPhone lease counts against the iOS limit of a per-platform lease.maxPerRequester", async () => {
    const harness = await createHarness({ lease: { maxPerRequester: { ios: 1, android: 1 } } });
    await enrollIphone(harness, "UDID-A");
    const phone = await harness.engine.request(physicalRequest, asking("agent-1"));

    const simulator = await outcome(harness.engine.request(virtualRequest, asking("agent-1")));

    expect(simulator).toMatchObject({
      message: `Requester agent-1 already holds iOS lease ${phone.lease.id}; release it (\`simlock release ${phone.lease.id}\`) before requesting another iOS device`,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("declines a probe for a physical request nothing could match unresolvable-spec, and one whose matches are all leased no-wait", async () => {
    const none = await createHarness();
    const unmatched = await outcome(
      none.engine.request(
        physicalRequest,
        asking("gateway", { fleetRequestId: "fleet_1", noWait: true }),
      ),
    );
    const busy = await createHarness();
    await enrollIphone(busy, "UDID-A");
    await busy.engine.request(physicalRequest, asking("holder"));
    const leased = await outcome(
      busy.engine.request(
        physicalRequest,
        asking("gateway", { fleetRequestId: "fleet_2", noWait: true }),
      ),
    );

    expect(unmatched).toBeInstanceOf(UnknownModelError);
    expect(eventsNamed(none, "lease.requested")).toMatchObject([
      { payload: { requestSpec: { physical: true } } },
    ]);
    expect(eventsNamed(none, "lease.declined")).toMatchObject([
      {
        payload: {
          fleetRequestId: "fleet_1",
          reason: "unresolvable-spec",
          requestSpec: { physical: true },
        },
      },
    ]);
    expect(leased).toBeInstanceOf(NoCapacityError);
    expect(eventsNamed(busy, "lease.declined")).toMatchObject([
      {
        payload: { fleetRequestId: "fleet_2", reason: "no-wait", requestSpec: { physical: true } },
      },
    ]);
  });
});

describe("createLeasing with a physical and a virtual line", () => {
  it("emits queue.changed with physical true for a physical waiter and with the depth alone for a virtual one", async () => {
    const { harness, marker } = await queuedLines();

    const changes = harness.bus
      .replay()
      .slice(marker)
      .filter((event) => event.event === "queue.changed")
      .map((event) => event.payload);

    expect(changes).toEqual([
      { depth: 1, physical: true },
      { depth: 2, physical: true },
      { depth: 1 },
    ]);
  });

  it("numbers lease.queued within the line the request waits in", async () => {
    const { harness, marker } = await queuedLines();

    const positions = harness.bus
      .replay()
      .slice(marker)
      .filter((event) => event.event === "lease.queued")
      .map((event) => event.payload.queuePosition);

    expect(positions).toEqual([1, 2, 1]);
  });

  it("reports the depth of each line apart through queueDepth and physicalQueueDepth", async () => {
    const { harness } = await queuedLines();

    expect([
      harness.engine.queueDepth,
      harness.engine.physicalQueueDepth,
      harness.engine.leasing.queueDepth,
      harness.engine.leasing.physicalQueueDepth,
    ]).toEqual([1, 2, 1, 2]);
  });

  it("lists a waiting physical request with physical true and a waiting virtual one without it, each with why it waits", async () => {
    const { harness } = await queuedLines();

    expect(harness.engine.waitingRequests().map((waiting) => waiting.spec)).toEqual([
      { model: "iPhone 15 Pro", physical: true, platform: "ios" },
      { model: "iPhone 15 Pro", physical: true, platform: "ios" },
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    ]);
    expect(harness.engine.waitingRequests()).toMatchObject([
      { requesterId: "physical-1", reason: "no-free-physical", stage: "queued" },
      { requesterId: "physical-2", reason: "no-free-physical", stage: "queued" },
      { requesterId: "virtual-1", reason: "device-limit", stage: "queued" },
    ]);
  });
});

async function enrollPhone(
  harness: Harness,
  driverDeviceId: string,
  model: string,
  osVersion = "18.4",
  deviceClass: "phone" | "tablet" = "phone",
): Promise<PhysicalDevice> {
  const device = await harness.registry.enrollPhysical({
    apps: [],
    class: deviceClass,
    driverDeviceId,
    model,
    osVersion,
    platform: "ios",
  });
  harness.driver.setPhysicalPresence(driverDeviceId, true);
  return device;
}

describe("createLeasing: which physical device a request is granted", () => {
  it("records a physical grant as lease.granted from a warm device", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");

    await harness.engine.request(physicalRequest, asking("agent"));

    expect(eventsNamed(harness, "lease.granted")).toMatchObject([
      { payload: { deviceId: device.id, requester: "agent", source: "warm" } },
    ]);
  });

  it("grants the enrolled device whose model the request names, not the first enrolled one", async () => {
    const harness = await createHarness();
    await enrollPhone(harness, "UDID-A", "iPhone 15 Pro");
    const second = await enrollPhone(harness, "UDID-B", "iPhone 14");

    const result = await outcome(
      harness.engine.request({ model: "iPhone 14", physical: true, platform: "ios" }, asking("a")),
    );

    expect(result).toMatchObject({ device: { id: second.id } });
  });

  it("refuses a physical request whose os version no enrolled device has, and grants it with the version one has", async () => {
    const accepted = await createHarness();
    const device = await enrollPhone(accepted, "UDID-A", "iPhone 15 Pro", "18.4");
    const refused = await createHarness();
    await enrollPhone(refused, "UDID-A", "iPhone 15 Pro", "18.4");

    const granted = await outcome(
      accepted.engine.request({ ...physicalRequest, osVersion: "18.4" }, asking("a")),
    );
    const result = await outcome(
      refused.engine.request({ ...physicalRequest, osVersion: "17.0" }, asking("a")),
    );

    expect(granted).toMatchObject({ device: { id: device.id } });
    expect(result).toBeInstanceOf(UnknownModelError);
    expect(eventsNamed(refused, "lease.rejected")).toMatchObject([
      { payload: { reason: "unresolvable-spec" } },
    ]);
  });

  it("refuses a physical request for a class no enrolled device has, and grants one for the class a device has", async () => {
    const accepted = await createHarness();
    const device = await enrollPhone(accepted, "UDID-A", "iPhone 15 Pro");
    const refused = await createHarness();
    await enrollPhone(refused, "UDID-A", "iPhone 15 Pro");

    const granted = await outcome(
      accepted.engine.request({ class: "phone", physical: true, platform: "ios" }, asking("a")),
    );
    const result = await outcome(
      refused.engine.request({ class: "tablet", physical: true, platform: "ios" }, asking("a")),
    );

    expect(granted).toMatchObject({ device: { id: device.id } });
    expect(result).toBeInstanceOf(UnknownModelError);
  });

  it("names the class on the error of a class request and the model on the error of a model request", async () => {
    const harness = await createHarness();
    await enrollPhone(harness, "UDID-A", "iPhone 15 Pro");

    const byClass = await outcome(
      harness.engine.request({ class: "tablet", physical: true, platform: "ios" }, asking("a")),
    );
    const byModel = await outcome(
      harness.engine.request(
        { class: "tablet", model: "iPad Pro", physical: true, platform: "ios" },
        asking("b"),
      ),
    );

    expect(byClass).toMatchObject({ class: "tablet", model: undefined });
    expect(byModel).toMatchObject({ class: undefined, model: "iPad Pro" });
  });

  it("refuses a physical request that only an unenrolled physical device matches, and grants it while the device is enrolled", async () => {
    const enrolled = await createHarness();
    const device = await enrollIphone(enrolled, "UDID-A");
    const unenrolled = await createHarness();
    const gone = await enrollIphone(unenrolled, "UDID-A");
    await unenrolled.registry.unenrollPhysical(gone.id);

    const granted = await outcome(enrolled.engine.request(physicalRequest, asking("a")));
    const result = await outcome(unenrolled.engine.request(physicalRequest, asking("a")));

    expect(granted).toMatchObject({ device: { id: device.id } });
    expect(result).toBeInstanceOf(UnknownModelError);
  });

  it("refuses a physical request that only a virtual device matches", async () => {
    const harness = await createHarness();
    await harness.engine.request(virtualRequest, asking("virtual-holder"));

    const result = await outcome(
      harness.engine.request({ ...physicalRequest, model: "iPhone 16" }, asking("a")),
    );

    expect(result).toBeInstanceOf(UnknownModelError);
  });

  it("skips a ready physical device that another operation holds and grants the next one", async () => {
    const harness = await createHarness();
    const busy = await enrollPhone(harness, "UDID-A", "iPhone 15 Pro");
    const free = await enrollPhone(harness, "UDID-B", "iPhone 14");
    const hold = harness.engine.core.claims.tryClaim(busy.id, "cleanup");

    const result = await outcome(
      harness.engine.request({ class: "phone", physical: true, platform: "ios" }, asking("agent")),
    );

    expect(hold).toBeDefined();
    expect(result).toMatchObject({ device: { id: free.id } });
    expect(claimKind(harness, busy)).toBe("cleanup");
  });

  it("does not hold a ready physical device for an older virtual waiter that asks for the same model", async () => {
    const harness = await createHarness();
    const device = await enrollPhone(harness, "UDID-A", "iPhone 16", "26.5");
    await harness.engine.request(virtualRequest, asking("virtual-holder"));
    void harness.engine.request(virtualRequest, asking("virtual-waiter"));
    await flush();

    const result = await outcome(
      harness.engine.request({ model: "iPhone 16", physical: true, platform: "ios" }, asking("a")),
    );

    expect(harness.engine.queueDepth).toBe(1);
    expect(result).toMatchObject({ device: { id: device.id } });
  });
});

function holdDecisions(harness: Harness): () => Promise<void> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const running = harness.decisions.run(async () => gate);
  return async () => {
    open();
    await running;
  };
}

describe("createLeasing: waking the queue", () => {
  it("drives only the virtual head, and not a virtual waiter behind it, when the queue is woken", async () => {
    const harness = await createHarness({ reclaimEstimateMs: 34_000 });
    await harness.engine.request(virtualRequest, asking("holder"));
    const holding = harness.registry.snapshot.devices[0];
    if (holding === undefined) throw new Error("no device");
    await harness.registry.transitionDevice(holding.id, "reclaiming");
    const behind: LeaseProgress[] = [];
    const head: LeaseProgress[] = [];
    void harness.engine.request(
      virtualRequest,
      asking("head", { onProgress: (update: LeaseProgress) => head.push(update) }),
    );
    void harness.engine.request(
      virtualRequest,
      asking("behind", { onProgress: (update: LeaseProgress) => behind.push(update) }),
    );
    await flush();
    const headBefore = head.length;
    const behindBefore = behind.length;

    harness.engine.leasing.corePorts.notifyAvailability();
    await flush();

    expect(head.length).toBeGreaterThan(headBefore);
    expect(behind).toHaveLength(behindBefore);
  });
});

describe("createLeasing: a physical grant that goes wrong", () => {
  it("times out a waiter whose deadline passes while its next plan waits, and releases the claim that plan took", async () => {
    const harness = await createHarness();
    await enrollPhone(harness, "UDID-A", "iPhone 15 Pro");
    const spare = await enrollPhone(harness, "UDID-B", "iPhone 14");
    harness.driver.setPhysicalPresence("UDID-A", false);
    harness.driver.setPhysicalPresence("UDID-B", false);
    const promise = harness.engine.request(
      { class: "phone", physical: true, platform: "ios" },
      asking("agent", { timeoutMs: 1_000 }),
    );
    await flush();
    harness.driver.setPhysicalPresence("UDID-A", true);
    harness.driver.holdPresenceReads("UDID-A");
    harness.engine.leasing.corePorts.notifyAvailability();
    await flush();
    harness.driver.setPhysicalPresence("UDID-A", false);
    const releaseFirst = holdDecisions(harness);
    harness.driver.releasePresenceReads();
    await flush();
    const releaseSecond = holdDecisions(harness);
    await releaseFirst();
    await flush();
    harness.clock.advance(1_000);

    await releaseSecond();
    const result = await outcome(promise);

    expect(result).toBeInstanceOf(QueueTimeoutError);
    expect(harness.engine.core.claims.isClaimed(spare.id)).toBe(false);
    expect(presenceReads(harness)).toEqual([["UDID-A"], ["UDID-B"], ["UDID-A"]]);
  });

  it("does not read the presence of a device again for a queued waiter when an older waiter finds it absent", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    harness.driver.holdPresenceReads("UDID-A");
    const older = harness.engine.request(physicalRequest, asking("older"));
    await flush();
    const newer = harness.engine.request(physicalRequest, asking("newer"));
    await flush();
    harness.driver.setPhysicalPresence("UDID-A", false);

    harness.driver.releasePresenceReads();

    expect(await outcome(older)).toBe("pending");
    expect(await outcome(newer)).toBe("pending");
    expect(presenceReads(harness)).toEqual([["UDID-A"]]);
  });
});
