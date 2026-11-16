import { afterEach, describe, expect, it } from "vitest";
import { type DeviceRequest, UnknownLeaseError } from "../core/index.js";
import {
  END_WAIT_MS,
  type Harness,
  PROBE_MS,
  TestParticipant,
  asking,
  destroys,
  driverDeviceOf,
  endStartupLease,
  errorsFor,
  flush,
  leaseAndRelease,
  markerOf,
  request,
  settledOrPending,
  startEngine,
  started,
  stateOf,
  withoutUnhandledRejections,
} from "./test-lease-end-participants.js";

const physicalRequest = {
  model: "iPhone 15 Pro",
  physical: true,
  platform: "ios",
} as const satisfies DeviceRequest;

afterEach(() => {
  for (const engine of started.splice(0)) engine.dispose();
});

describe("lease-end participants (#469)", () => {
  it("a startup ending with reclaim whose participant has not returned, followed by core.converge: converge leaves the device alone, and the device is destroyed once the participant returns", async () => {
    const participant = new TestParticipant();
    const { grant, second, world } = await endStartupLease({
      afterFirstStop: async (first, leased) => {
        await first.driver.shutdown(driverDeviceOf(first, leased.device.id));
      },
      participant,
    });
    const callsBefore = world.driver.calls.length;

    await second.engine.convergeRunningCapacity();
    await flush();

    expect(participant.calls).toHaveLength(1);
    expect(
      world.driver.calls.slice(callsBefore).filter((call) => call.operation === "shutdown"),
    ).toEqual([]);
    expect(
      world.bus
        .replay()
        .filter(
          (event) =>
            String(event.event) === "device.shutdown" &&
            (event.payload as { initiator?: string }).initiator === "startup-interrupted-reclaim",
        ),
    ).toEqual([]);
    expect(destroys(world.driver)).toHaveLength(0);

    participant.calls[0]?.resolve();
    await flush();
    await second.engine.settle();
    expect(destroys(world.driver)).toHaveLength(1);
    expect(stateOf(second, grant.device.id)).toBe("deleted");
  });

  it("a startup ending with wait calls the participant with its reason, starts no destroy, and leaves the device reclaiming with its deferred wipe recorded", async () => {
    const participant = new TestParticipant();
    const { grant, second, world } = await endStartupLease({
      afterFirstStop: (first) => {
        first.driver.failOn(
          "listManaged",
          first.driver.calls.filter((call) => call.operation === "listManaged").length + 1,
          new Error("cannot list"),
        );
      },
      participant,
    });

    await second.engine.convergeRunningCapacity();
    await flush();
    participant.calls[0]?.resolve();
    await flush();

    expect(participant.calls.map((call) => call.ended)).toMatchObject([
      { deviceId: grant.device.id, leaseId: grant.lease.id, reason: "device-lost" },
    ]);
    expect(destroys(world.driver)).toHaveLength(0);
    expect(stateOf(second, grant.device.id)).toBe("reclaiming");
    expect(markerOf(second, grant.device.id)).toBe(grant.lease.id);
  });

  it("a startup ending with missing calls the participant and marks the device missing, without waiting for it", async () => {
    const participant = new TestParticipant();
    const { grant, second } = await endStartupLease({
      afterFirstStop: (first) => {
        first.driver.setManagedReality({ devices: [], processes: [] });
      },
      participant,
    });

    await expect(
      settledOrPending(second.engine.convergeRunningCapacity()),
    ).resolves.toBeUndefined();

    expect(participant.calls.map((call) => call.ended)).toMatchObject([
      { deviceId: grant.device.id, leaseId: grant.lease.id, reason: "device-lost" },
    ]);
    expect(stateOf(second, grant.device.id)).toBe("deleted");
    expect(second.registry.snapshot.leases).toEqual([]);
  });

  it("a physical device that goes absent (through PhysicalDeviceWatcher) calls the participant with device-lost, and the device becomes absent without waiting for it", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const device = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-A",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    harness.driver.setPhysicalPresence("UDID-A", true);
    (
      harness.engine.leasing as unknown as { physicalDeviceWatcher: { start(): void } }
    ).physicalDeviceWatcher.start();
    await harness.engine.request(physicalRequest, asking("agent"));

    harness.driver.setPhysicalPresence("UDID-A", false);
    for (let tick = 0; tick < 3; tick += 1) {
      harness.clock.advance(PROBE_MS);
      await flush();
    }

    expect(participant.calls.map((call) => call.ended)).toMatchObject([
      { deviceId: device.id, platform: "ios", reason: "device-lost" },
    ]);
    expect(stateOf(harness, device.id)).toBe("absent");
  });

  it("a call nothing waits for, still running at the ceiling, has its signal aborted then", async () => {
    const participant = new TestParticipant();
    const { second } = await endStartupLease({
      afterFirstStop: (first) => {
        first.driver.failOn(
          "listManaged",
          first.driver.calls.filter((call) => call.operation === "listManaged").length + 1,
          new Error("cannot list"),
        );
      },
      participant,
    });
    await second.engine.convergeRunningCapacity();
    await flush();
    expect(participant.calls).toHaveLength(1);

    second.clock.advance(END_WAIT_MS - 1);
    await flush();
    expect(participant.calls[0]?.signal.aborted).toBe(false);

    second.clock.advance(1);
    await flush();
    expect(participant.calls[0]?.signal.aborted).toBe(true);
  });

  it("a call nothing waits for that rejects is logged as an error with the lease id", async () => {
    await withoutUnhandledRejections(async () => {
      const participant = new TestParticipant();
      const { grant, second, world } = await endStartupLease({
        afterFirstStop: (first) => {
          first.driver.failOn(
            "listManaged",
            first.driver.calls.filter((call) => call.operation === "listManaged").length + 1,
            new Error("cannot list"),
          );
        },
        participant,
      });
      await second.engine.convergeRunningCapacity();
      await flush();
      expect(participant.calls).toHaveLength(1);

      participant.calls[0]?.reject(new Error("rejected unwaited"));
      await flush();

      expect(errorsFor(world, grant.lease.id)).toMatchObject([
        { fields: { error: "rejected unwaited" } },
      ]);
    });
  });

  it("a release of an unknown lease calls no participant", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    await harness.engine.request(request, asking("agent"));

    await expect(harness.engine.release("no-such-lease", "explicit")).rejects.toBeInstanceOf(
      UnknownLeaseError,
    );
    await flush();

    expect(participant.calls).toEqual([]);
  });

  it("an expiry whose deadline was moved by a renew calls no participant", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      lease: { defaultTtlMs: 100 },
      participants: [participant],
    });
    const grant = await harness.engine.request(request, asking("agent"));
    harness.clock.advance(90);
    await harness.engine.renew(grant.lease.id, 100);

    harness.clock.advance(20);
    await flush();

    expect(harness.registry.snapshot.leases).toHaveLength(1);
    expect(participant.calls).toEqual([]);
  });

  it.each([
    [
      "nuke",
      (harness: Harness) => harness.engine.nuke(false),
      { releasedLeaseIds: [], removedBaselines: [] },
    ],
    ["settle()", (harness: Harness) => harness.engine.settle(), undefined],
  ] as const)(
    "%s while a participant has not returned aborts its signal, starts the destroy at once, and completes without the clock advancing",
    async (_call, run, completed) => {
      const { harness, participant } = await leaseAndRelease();
      expect(participant.calls).toHaveLength(1);

      const running = run(harness);

      await expect(settledOrPending(running)).resolves.toEqual(completed);
      expect(participant.calls[0]?.signal.aborted).toBe(true);
      expect(destroys(harness.driver)).toHaveLength(1);
    },
  );
});
