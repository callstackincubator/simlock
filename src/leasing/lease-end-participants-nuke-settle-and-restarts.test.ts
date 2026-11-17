import { afterEach, describe, expect, it } from "vitest";
import { NoCapacityError } from "./index.js";
import {
  END_WAIT_MS,
  TestParticipant,
  type World,
  asking,
  createWorld,
  destroys,
  flush,
  leaseAndRelease,
  markerOf,
  request,
  settledOrPending,
  startEngine,
  started,
  stateOf,
  warningsFor,
} from "./test-lease-end-participants.js";

const otherRequest = { model: "iPhone 15", osVersion: "26.5", platform: "ios" } as const;

function eventNames(world: World): string[] {
  return world.bus.replay().map((event) => String(event.event));
}

afterEach(() => {
  for (const engine of started.splice(0)) engine.dispose();
});

describe("lease-end participants (#469)", () => {
  it("advancing the clock past lease.endWaitMs after a nuke cut a wait short, and the participant then resolving, logs no ceiling warning and starts no second destroy", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    await harness.engine.nuke(false);
    expect(destroys(harness.driver)).toHaveLength(1);

    harness.clock.advance(END_WAIT_MS + 1);
    participant.calls[0]?.resolve();
    await flush();

    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
    expect(destroys(harness.driver)).toHaveLength(1);
  });

  it("nuke with leased devices calls each participant with an already aborted signal, and completes without the clock advancing even when the participant never returns", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({
      ios: { maxDevices: 2, maxRunning: 2 },
      participants: [participant],
    });
    const one = await harness.engine.request(request, asking("one"));
    const two = await harness.engine.request(request, asking("two"));

    const nuking = harness.engine.nuke(false);

    await expect(settledOrPending(nuking)).resolves.toMatchObject({
      releasedLeaseIds: expect.arrayContaining([one.lease.id, two.lease.id]),
    });
    expect(participant.calls.map((call) => call.abortedAtCall)).toEqual([true, true]);
  });

  it("after nuke ends, a release waits for its participant again", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    await harness.engine.nuke(false);
    const grant = await harness.engine.request(request, asking("agent"));

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    expect(participant.calls).toHaveLength(1);
    expect(participant.calls[0]?.abortedAtCall).toBe(false);
    expect(destroys(harness.driver)).toHaveLength(0);
  });

  it("when the participant resolves after settle(), the driver's destroy has run once, and advancing past lease.endWaitMs logs no ceiling warning", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    await harness.engine.settle();

    participant.calls[0]?.resolve();
    harness.clock.advance(END_WAIT_MS + 1);
    await flush();

    expect(destroys(harness.driver)).toHaveLength(1);
    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
  });

  it("a release after settle() began calls the participant with an already aborted signal and destroys at once", async () => {
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant] });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.settle();

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    expect(participant.calls.map((call) => call.abortedAtCall)).toEqual([true]);
    expect(destroys(harness.driver)).toHaveLength(1);
  });

  it("a participant that returns before the ceiling: advancing the clock past lease.endWaitMs afterwards logs no ceiling warning and aborts no signal", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    participant.calls[0]?.resolve();
    await flush();

    harness.clock.advance(END_WAIT_MS + 1);
    await flush();

    expect(destroys(harness.driver)).toHaveLength(1);
    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
    expect(participant.calls[0]?.signal.aborted).toBe(false);
  });

  it("dispose() with a participant still running aborts its signal; advancing the clock past lease.endWaitMs afterwards, and the participant then resolving, logs no ceiling warning and starts no destroy", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);

    harness.engine.dispose();
    expect(participant.calls[0]?.signal.aborted).toBe(true);
    harness.clock.advance(END_WAIT_MS + 1);
    participant.calls[0]?.resolve();
    await flush();

    expect(warningsFor(harness, grant.lease.id)).toEqual([]);
    expect(destroys(harness.driver)).toEqual([]);
  });

  it("with no participant, the destroy starts without the clock advancing, the device is shut down while it runs, and the record carries no deferred-reclaim marker", async () => {
    const world = await createWorld({ latencyMs: { destroy: 20 } });
    const harness = await startEngine({ world });
    const grant = await harness.engine.request(request, asking("agent"));

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    expect(destroys(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, grant.device.id)).toBe("shutdown");
    expect(markerOf(harness, grant.device.id)).toBeUndefined();
  });

  it("with a participant, the device is reclaiming with its deferred-reclaim marker while the participant runs, and the marker is gone once the device is deleted", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    expect(stateOf(harness, grant.device.id)).toBe("reclaiming");
    expect(markerOf(harness, grant.device.id)).toBe(grant.lease.id);

    participant.calls[0]?.resolve();
    await flush();

    expect(stateOf(harness, grant.device.id)).toBe("deleted");
    expect(markerOf(harness, grant.device.id)).toBeUndefined();
  });

  it("with running capacity full, while a participant waits, a lease request for another spec queues, and a noWait request gets NO_CAPACITY; the queued one is granted once the wait and the destroy end", async () => {
    const { harness, participant } = await leaseAndRelease({
      ios: { maxDevices: 2, maxRunning: 1 },
    });
    expect(participant.calls).toHaveLength(1);

    const queued = harness.engine.request(otherRequest, asking("queued"));
    const refused = harness.engine.request(otherRequest, { ...asking("hurried"), noWait: true });

    await expect(refused).rejects.toBeInstanceOf(NoCapacityError);
    await expect(settledOrPending(queued)).resolves.toBe("still pending");
    participant.calls[0]?.resolve();
    await flush();
    await harness.engine.settle();
    await expect(settledOrPending(queued)).resolves.toMatchObject({
      lease: { requesterId: "queued" },
    });
  });

  it("a daemon stopped while a participant has not returned: a new engine on the same registry wipes nothing, destroys the device, and calls no participant registered in the new engine", async () => {
    const { grant, harness, participant } = await leaseAndRelease();
    expect(participant.calls).toHaveLength(1);
    const replacement = new TestParticipant();

    const restarted = await startEngine({ participants: [replacement], world: harness.world });
    await restarted.engine.convergeRunningCapacity();
    await flush();
    await restarted.engine.settle();

    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toEqual([]);
    expect(destroys(harness.driver)).toHaveLength(1);
    expect(stateOf(restarted, grant.device.id)).toBe("deleted");
    expect(replacement.calls).toEqual([]);
  });

  it("a daemon stopped during the destroy that follows the wait destroys the device again at the next start", async () => {
    const world = await createWorld({ latencyMs: { destroy: 20 } });
    const participant = new TestParticipant();
    const harness = await startEngine({ participants: [participant], world });
    const grant = await harness.engine.request(request, asking("agent"));
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(participant.calls).toHaveLength(1);
    participant.calls[0]?.resolve();
    await flush();
    expect(destroys(world.driver)).toHaveLength(1);
    const destroysBefore = destroys(world.driver).length;

    const restarted = await startEngine({ world });
    const converging = restarted.engine.convergeRunningCapacity();
    for (let tick = 0; tick < 5; tick += 1) {
      world.clock.advance(20);
      await flush();
    }
    await converging;

    expect(destroys(world.driver).length - destroysBefore).toBe(1);
  });

  it("a release with a participant emits the same events in the same order as one without (lease.released, then device.deleted)", async () => {
    const plain = await startEngine();
    const plainGrant = await plain.engine.request(request, asking("agent"));
    const plainBefore = eventNames(plain).length;
    await plain.engine.release(plainGrant.lease.id, "explicit");
    await flush();
    await plain.engine.settle();

    const participant = new TestParticipant();
    const waiting = await startEngine({ participants: [participant] });
    const waitingGrant = await waiting.engine.request(request, asking("agent"));
    const waitingBefore = eventNames(waiting).length;
    await waiting.engine.release(waitingGrant.lease.id, "explicit");
    await flush();
    expect(participant.calls).toHaveLength(1);
    participant.calls[0]?.resolve();
    await flush();
    await waiting.engine.settle();

    const expected = eventNames(plain).slice(plainBefore);
    expect(expected.indexOf("lease.released")).toBeLessThan(expected.indexOf("device.deleted"));
    expect(eventNames(waiting).slice(waitingBefore)).toEqual(expected);
  });
});
