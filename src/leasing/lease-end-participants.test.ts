import { afterEach, describe, expect, it } from "vitest";
import { type LeaseGrant } from "../core/index.js";
import type { LeaseEndParticipant } from "./lease-ports.js";
import {
  END_WAIT_MS,
  PROBE_MS,
  TestParticipant,
  asking,
  destroys,
  driverDeviceOf,
  endStartupLease,
  errorsFor,
  flush,
  leaseAndRelease,
  request,
  settledOrPending,
  startEngine,
  started,
  stateOf,
  warningsFor,
  withoutUnhandledRejections,
} from "./test-lease-end-participants.js";

class ThrowingParticipant implements LeaseEndParticipant {
  leaseEnded(): Promise<void> {
    throw new Error("participant threw");
  }
}

afterEach(() => {
  for (const engine of started.splice(0)) engine.dispose();
});

describe("lease-end participants (#469)", () => {
  it("a release answers its caller while the participant has not returned, and the participant gets the lease id, owner, simlock device id, platform and reason explicit", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const grant = await harness.engine.request(request, asking("agent"));

    const released = harness.engine.release(grant.lease.id, "explicit");

    await expect(settledOrPending(released)).resolves.toBeUndefined();
    await flush();
    expect(participant.calls.map((call) => call.ended)).toEqual([
      {
        deviceId: grant.device.id,
        grantedAt: 1_000,
        leaseId: grant.lease.id,
        ownerId: "agent-owner",
        platform: "ios",
        reason: "explicit",
      },
    ]);
  });

  it("the participant is called after lease.released is emitted, while the device is reclaiming and has no lease", async () => {
    const { grant, participant } = await leaseAndRelease();

    expect(participant.calls).toHaveLength(1);
    expect(participant.calls[0]?.observed).toMatchObject({
      deviceState: "reclaiming",
      leaseCount: 0,
    });
    expect(participant.calls[0]?.observed?.events).toContain("lease.released");
    expect(grant.device.id).toBe(participant.calls[0]?.ended.deviceId);
  });

  it("the device is not destroyed until the participant returns; when it returns, the device is destroyed and deleted", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    expect(destroys(harness.driver)).toHaveLength(0);
    expect(stateOf(harness, grant.device.id)).toBe("reclaiming");

    participant.calls[0]?.resolve();
    await flush();

    expect(destroys(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, grant.device.id)).toBe("deleted");
  });

  it("while the participant has not returned, a request for the same spec is not granted that device, and it is granted a new device once the ended one is destroyed", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    const second = harness.engine.request(request, asking("next"));

    await expect(settledOrPending(second)).resolves.toBe("still pending");
    participant.calls[0]?.resolve();
    await flush();
    await harness.engine.settle();
    const granted = (await settledOrPending(second)) as LeaseGrant;
    expect(granted).toMatchObject({ lease: { requesterId: "next" } });
    expect(granted.device.id).not.toBe(grant.device.id);
    expect(stateOf(harness, grant.device.id)).toBe("deleted");
  });

  it("the device is claimed from before the participant is called until the destroy ends", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    expect(participant.calls[0]?.observed?.claimed).toBe(true);
    expect(harness.engine.claimReader.isClaimed(grant.device.id)).toBe(true);
    participant.calls[0]?.resolve();
    await flush();
    await harness.engine.settle();
    expect(destroys(harness.driver)).toHaveLength(1);
    expect(harness.engine.claimReader.isClaimed(grant.device.id)).toBe(false);
  });

  it("while the participant has not returned, a renew of another lease and a grant of another device both complete", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      ios: { maxDevices: 3, maxRunning: 3 },
      participants: [participant],
    });
    const ending = await harness.engine.request(request, asking("ending"));
    const other = await harness.engine.request(request, asking("other"));
    await harness.engine.release(ending.lease.id, "explicit");
    await flush();
    expect(participant.calls).toHaveLength(1);

    const renewed = harness.engine.renew(other.lease.id, 120_000);
    const granted = harness.engine.request(request, asking("third"));

    await expect(settledOrPending(renewed)).resolves.toMatchObject({ id: other.lease.id });
    const third = await settledOrPending(granted);
    expect(third).toMatchObject({ lease: { requesterId: "third" } });
    expect((third as LeaseGrant).device.id).not.toBe(ending.device.id);
  });

  it("a participant that never returns: 1 ms before lease.endWaitMs the destroy has not started; at lease.endWaitMs its signal is aborted, a warning naming the lease and device is logged, and the destroy starts; when that participant resolves later, the driver's destroy has still run once", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS - 1);
    await flush();
    expect(destroys(harness.driver)).toHaveLength(0);
    expect(participant.calls[0]?.signal.aborted).toBe(false);

    harness.clock.advance(1);
    await flush();
    expect(participant.calls[0]?.signal.aborted).toBe(true);
    expect(warningsFor(harness, grant.lease.id)).toMatchObject([
      { fields: { deviceId: grant.device.id, leaseId: grant.lease.id } },
    ]);
    expect(destroys(harness.driver)).toHaveLength(1);

    participant.calls[0]?.resolve();
    await flush();
    expect(destroys(harness.driver)).toHaveLength(1);
  });

  it("two participants are both called before either returns; the destroy waits for the slower one", async () => {
    const fast = new TestParticipant();
    const slow = new TestParticipant();
    const harness = await startEngine({ participants: [fast, slow] });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(fast.calls).toHaveLength(1);
    expect(slow.calls).toHaveLength(1);

    fast.calls[0]?.resolve();
    await flush();
    expect(destroys(harness.driver)).toHaveLength(0);

    slow.calls[0]?.resolve();
    await flush();
    expect(destroys(harness.driver)).toHaveLength(1);
  });

  it("one ceiling, counted from the call, covers both participants and is not reset when the first returns", async () => {
    const fast = new TestParticipant();
    const slow = new TestParticipant();
    const harness = await startEngine({ participants: [fast, slow] });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(fast.calls).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS / 2);
    fast.calls[0]?.resolve();
    await flush();
    harness.clock.advance(END_WAIT_MS / 2 - 1);
    await flush();
    expect(destroys(harness.driver)).toHaveLength(0);

    harness.clock.advance(1);
    await flush();
    expect(slow.calls[0]?.signal.aborted).toBe(true);
    expect(destroys(harness.driver)).toHaveLength(1);
  });

  it("a participant that rejects, and one that throws, are each logged as an error with the lease id, device id and error message; the other participant is still awaited; the device is then destroyed", async () => {
    const rejecting = new TestParticipant();
    const waiting = new TestParticipant();
    const harness = await startEngine({
      participants: [rejecting, new ThrowingParticipant(), waiting],
    });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(rejecting.calls).toHaveLength(1);
    expect(waiting.calls).toHaveLength(1);

    rejecting.calls[0]?.reject(new Error("participant rejected"));
    await flush();
    expect(destroys(harness.driver)).toHaveLength(0);
    expect(errorsFor(harness, grant.lease.id)).toMatchObject([
      { fields: { deviceId: grant.device.id, error: "participant threw" } },
      { fields: { deviceId: grant.device.id, error: "participant rejected" } },
    ]);

    waiting.calls[0]?.resolve();
    await flush();
    expect(stateOf(harness, grant.device.id)).toBe("deleted");
  });

  it("a participant that rejects after the ceiling passed is logged as an error with the lease id; the run reports no unhandled rejection", async () => {
    await withoutUnhandledRejections(async () => {
      const { grant, harness, participant } = await leaseAndRelease();
      expect(participant.calls).toHaveLength(1);
      harness.clock.advance(END_WAIT_MS);
      await flush();
      expect(destroys(harness.driver)).toHaveLength(1);

      participant.calls[0]?.reject(new Error("rejected late"));
      await flush();

      expect(errorsFor(harness, grant.lease.id)).toMatchObject([
        { fields: { error: "rejected late" } },
      ]);
    });
  });

  it("a participant that rejects after nuke cut its wait short is logged as an error with the lease id; the run reports no unhandled rejection", async () => {
    await withoutUnhandledRejections(async () => {
      const { grant, harness, participant } = await leaseAndRelease();
      expect(participant.calls).toHaveLength(1);
      await harness.engine.nuke(false);

      participant.calls[0]?.reject(new Error("rejected after nuke"));
      await flush();

      expect(errorsFor(harness, grant.lease.id)).toMatchObject([
        { fields: { error: "rejected after nuke" } },
      ]);
    });
  });

  it("release with reason killed calls the participant with that reason before the destroy", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const grant = await harness.engine.request(request, asking("agent"));

    await harness.engine.release(grant.lease.id, "killed");
    await flush();

    expect(participant.calls.map((call) => call.ended.reason)).toEqual(["killed"]);
    expect(destroys(harness.driver)).toHaveLength(0);
  });

  it("releaseAll calls the participant once per lease, before any destroy", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      ios: { maxDevices: 2, maxRunning: 2 },
      participants: [participant],
    });
    const first = await harness.engine.request(request, asking("one"));
    const second = await harness.engine.request(request, asking("two"));

    await harness.engine.releaseAll("explicit");
    await flush();

    expect(participant.calls.map((call) => call.ended.leaseId).sort()).toEqual(
      [first.lease.id, second.lease.id].sort(),
    );
    expect(destroys(harness.driver)).toHaveLength(0);
  });

  it("an expiry calls the participant with reason expired before the destroy", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ lease: { defaultTtlMs: 10 }, participants: [participant] });
    await harness.engine.request(request, asking("agent"));

    harness.clock.advance(10);
    await flush();

    expect(participant.calls.map((call) => call.ended.reason)).toEqual(["expired"]);
    expect(destroys(harness.driver)).toHaveLength(0);
  });

  it("the health monitor's device-lost release calls the participant with reason device-lost before the destroy", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    await harness.engine.request(request, asking("agent"));
    harness.driver.setManagedReality({ devices: [], processes: [] });

    harness.engine.healthMonitor.start();
    for (let tick = 0; tick < 3; tick += 1) {
      harness.clock.advance(PROBE_MS);
      await flush();
    }
    harness.engine.healthMonitor.dispose();

    expect(participant.calls.map((call) => call.ended.reason)).toEqual(["device-lost"]);
    expect(destroys(harness.driver)).toHaveLength(0);
  });

  it.each([
    ["expired", 10_000],
    ["device-lost", 3_600_000],
  ] as const)(
    "a startup ending with reclaim calls the participant with reason %s before the destroy",
    async (reason, ttlMs) => {
      const participant = new TestParticipant();
      const { grant, second, world } = await endStartupLease({
        afterFirstStop: async (first, leased) => {
          await first.driver.shutdown(driverDeviceOf(first, leased.device.id));
          first.clock.advance(20_000);
        },
        participant,
        ttlMs,
      });

      await second.engine.convergeRunningCapacity();
      await flush();

      expect(participant.calls.map((call) => call.ended)).toMatchObject([
        { deviceId: grant.device.id, leaseId: grant.lease.id, reason },
      ]);
      expect(destroys(world.driver)).toHaveLength(0);
    },
  );
});
