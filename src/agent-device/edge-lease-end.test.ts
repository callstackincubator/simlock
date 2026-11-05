import { describe, expect, it } from "vitest";

import {
  advance,
  release,
  devices,
  liveStates,
  grantedDevice,
  track,
  listed,
  runningCommand,
} from "./test-edge.js";
import {
  secrets,
  principals,
  notAvailable,
  scope,
  adminSession,
  sessionFor,
  type Rig,
  sleep,
  setUp,
  send,
  envelopeOf,
  hex,
  allocate,
  granted,
  receivedAllocate,
  allocatesReceived,
} from "./test-support.js";

// why: Fallow reads a `rig` binding's type only from an annotation in this file, not from an imported
// setUp's return type, so a `rig` whose test calls a FakeAgentDevice member only these tests use is
// annotated `Rig`; without it Fallow reports the member as never referenced.

const wipeOperations = new Set(["reclaim", "shutdown", "destroy"]);

function wipes(rig: Rig): number {
  return rig.driver.calls.filter((call) => wipeOperations.has(call.operation)).length;
}

function releasesReceived(rig: Rig) {
  return rig.fake.rpcRequests("agent_device.lease.release");
}

async function releaseAll(rig: Rig): Promise<void> {
  await rig.daemon.dispatch("lease.release-all", {}, adminSession);
}

// why: the wipe count the agent-device daemon saw when each release reached it says whether the wipe had started.
function watchWipes(rig: Rig): number[] {
  const seen: number[] = [];
  rig.fake.onRelease = async () => {
    seen.push(wipes(rig));
  };
  return seen;
}

function gateOnRelease(rig: Rig): () => void {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  rig.fake.onRelease = () => held;
  return open;
}

async function plainLease(rig: Rig, requesterId: string): Promise<void> {
  await rig.daemon.dispatch(
    "lease.request",
    { model: "iPhone 16", platform: "ios", requesterId },
    sessionFor(principals.one),
  );
}

describe("simlock ending a simlock lease ends the agent-device session first", () => {
  it("release-all while an agent holds a device sends agent-device a release with the agent's principal as tenant and the run ID, lease provider and client ID of the allocate reply, plus its device key when the reply names one", async () => {
    const rig: Rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("device-key-1");
    await granted(rig, 1);

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    const sent = releasesReceived(rig)[0];
    expect(sent?.tenant).toBe(principals.one);
    expect(sent?.params).toEqual({
      ...scope,
      deviceKey: "device-key-1",
      leaseId: hex(1),
      tenantId: principals.one,
    });

    const plain = await setUp();
    await granted(plain, 1);
    await releaseAll(plain);
    await expect.poll(() => releasesReceived(plain).length).toBe(1);
    expect(releasesReceived(plain)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
  });

  it("release-all while an agent holds a device whose allocate reply named an empty device key (under 1 character) sends agent-device a release without a `deviceKey`", async () => {
    const rig: Rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("");
    await granted(rig, 1);

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    expect(releasesReceived(rig)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
  });

  it("an allocate reply whose device key is `ios:mobile:<id>` is recorded, and release-all sends that device key in the release", async () => {
    const rig: Rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("ios:mobile:00008110-001A2B3C4D5E");
    await granted(rig, 1);

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    expect(releasesReceived(rig)[0]?.params).toMatchObject({
      deviceKey: "ios:mobile:00008110-001A2B3C4D5E",
      leaseId: hex(1),
    });
  });

  it("release-all: the driver's reclaim of the device starts only after agent-device answers that release", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const before = wipes(rig);
    const answer = gateOnRelease(rig);

    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    await sleep(50);

    expect(wipes(rig)).toBe(before);
    answer();
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
  });

  it("a command still running at release-all finishes before the driver's reclaim of that device starts", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const running = await runningCommand(rig, 1);
    const before = wipes(rig);

    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    await sleep(50);

    expect(running.done()).toBe(false);
    expect(wipes(rig)).toBe(before);
    rig.fake.releaseCommand();
    await running.promise;
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
  });

  it("while the host waits for that release, the device stays `reclaiming` and a second agent's open for the same model is not granted it", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await sleep(100);

    expect((await devices(rig)).map((device) => device.state)).toEqual(["reclaiming"]);
    expect(second.done()).toBe(false);
    expect(allocatesReceived(rig, 2)).toEqual([]);
    rig.fake.releaseCommand();
    await second.promise;
  });

  it("once the release ends the device, a second agent's open is granted a new device", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    const device = await grantedDevice(rig);
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await sleep(50);
    expect(second.done()).toBe(false);

    rig.fake.releaseCommand();
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ ok: true });
    expect(receivedAllocate(rig, 2)["udid"]).not.toBe(device.address);
  });

  it("a simlock lease that expires, one an operator releases with `lease.release`, and one whose device is lost each send agent-device the same release before the reclaim starts", async () => {
    const expiring = await setUp();
    const atRelease = watchWipes(expiring);
    await granted(expiring, 1, { ttlMs: 30_000 });
    const expiringBefore = wipes(expiring);
    await advance(expiring, 31_000, 5_000);
    await expect.poll(() => releasesReceived(expiring).length).toBe(1);
    expect(releasesReceived(expiring)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
    expect(atRelease).toEqual([expiringBefore]);

    const operator = await setUp();
    const atOperatorRelease = watchWipes(operator);
    await granted(operator, 1);
    const operatorBefore = wipes(operator);
    await operator.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
    await expect.poll(() => releasesReceived(operator).length).toBe(1);
    expect(releasesReceived(operator)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
    expect(atOperatorRelease).toEqual([operatorBefore]);

    const lost = await setUp();
    const atLostRelease = watchWipes(lost);
    await granted(lost, 1);
    const lostBefore = wipes(lost);
    const reality = await lost.driver.listManaged();
    lost.driver.setManagedReality({
      ...reality,
      devices: reality.devices.map((device) => ({ ...device, runState: "stopped" as const })),
    });
    await advance(lost, 120_000, 15_000);
    await expect.poll(() => releasesReceived(lost).length).toBe(1);
    expect(releasesReceived(lost)[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: principals.one,
    });
    expect(atLostRelease).toEqual([lostBefore]);
  });

  it("the agent's own release, answered before simlock leasing ends the lease, leaves agent-device with no second release", async () => {
    const rig = await setUp();
    await granted(rig, 1);

    expect((await envelopeOf(await release(rig, 1))).result).toMatchObject({ released: true });
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
    await sleep(50);

    expect(releasesReceived(rig)).toHaveLength(1);
  });

  it.each(["an error", "a non-JSON body", "an unreachable daemon"])(
    "the agent's own release that agent-device answers with %s keeps the record: a later release-all sends the participant's release",
    async (failure) => {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      if (failure === "an error") {
        rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
      } else if (failure === "a non-JSON body") {
        rig.fake.answerNextReleaseWith("<html>bad gateway</html>");
      } else {
        rig.fake.setUnreachable(true);
      }
      await release(rig, 1);
      rig.fake.setUnreachable(false);
      expect(await listed(rig)).toEqual([hex(1)]);
      const before = releasesReceived(rig).length;

      await releaseAll(rig);

      await expect.poll(() => releasesReceived(rig).length).toBe(before + 1);
      expect(releasesReceived(rig).at(-1)?.params).toEqual({
        ...scope,
        leaseId: hex(1),
        tenantId: principals.one,
      });
    },
  );

  it("release-all while the agent's own release is in flight waits for it; when it succeeds, no second release is sent and the reclaim starts after it answers", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const before = wipes(rig);
    const answer = gateOnRelease(rig);
    const agentRelease = track(release(rig, 1));
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    await releaseAll(rig);
    await sleep(50);

    expect(releasesReceived(rig)).toHaveLength(1);
    expect(wipes(rig)).toBe(before);
    answer();
    await agentRelease.promise;
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toHaveLength(1);
  });

  it("release-all while the agent's own release is in flight: when it fails, or its CLI hangs up, the participant sends its own release before the reclaim", async () => {
    const failing = await setUp();
    await granted(failing, 1);
    const failingBefore = wipes(failing);
    const answerFailing = gateOnRelease(failing);
    failing.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
    const failedRelease = track(release(failing, 1));
    await expect.poll(() => releasesReceived(failing).length).toBe(1);
    await releaseAll(failing);
    const seenFailing = watchWipes(failing);

    answerFailing();
    await failedRelease.promise;

    await expect.poll(() => releasesReceived(failing).length).toBe(2);
    expect(seenFailing).toEqual([failingBefore]);
    await expect.poll(() => wipes(failing)).toBeGreaterThan(failingBefore);

    const hungUp = await setUp();
    await granted(hungUp, 1);
    const hungUpBefore = wipes(hungUp);
    const answerHungUp = gateOnRelease(hungUp);
    const hangUp = new AbortController();
    const abandoned = track(release(hungUp, 1, { signal: hangUp.signal }));
    await expect.poll(() => releasesReceived(hungUp).length).toBe(1);
    await releaseAll(hungUp);
    const seenHungUp = watchWipes(hungUp);
    hangUp.abort();
    await abandoned.promise.catch(() => undefined);
    await expect.poll(() => hungUp.fake.hungUpReleases).toEqual([hex(1)]);

    answerHungUp();

    await expect.poll(() => releasesReceived(hungUp).length).toBe(2);
    await expect.poll(() => seenHungUp).toEqual([hungUpBefore]);
    await expect.poll(() => wipes(hungUp)).toBeGreaterThan(hungUpBefore);
  });

  it("release-all while the agent's own release hangs: at lease.endWaitMs the wait ends and the reclaim starts", async () => {
    const rig: Rig = await setUp({ endWaitMs: 30_000 });
    await granted(rig, 1);
    const before = wipes(rig);
    rig.fake.hangNextRelease();
    const agentRelease = track(release(rig, 1));
    await expect.poll(() => releasesReceived(rig).length).toBe(1);
    await releaseAll(rig);

    await advance(rig, 20_000, 5_000);
    expect(wipes(rig)).toBe(before);
    await advance(rig, 15_000, 5_000);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    void agentRelease;
  });

  it("the agent's release sent while the participant's release is in flight answers released false, and the reclaim starts once the participant's release answers", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await runningCommand(rig, 1);
    const before = wipes(rig);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const agentRelease = await envelopeOf(await release(rig, 1));

    expect(agentRelease.result).toMatchObject({ ok: true, released: false });
    expect(wipes(rig)).toBe(before);
    rig.fake.releaseCommand();
    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
  });

  it("an agent holding two devices: release-all sends one release per lease, each with that lease's scope", async () => {
    const rig = await setUp();
    await granted(rig, 1, { clientId: "client-1", runId: "run-1" });
    await granted(rig, 2, { clientId: "client-2", runId: "run-2" });

    await releaseAll(rig);

    await expect.poll(() => releasesReceived(rig).length).toBe(2);
    const byLease = new Map(
      releasesReceived(rig).map((request) => [request.params?.["leaseId"], request.params]),
    );
    expect(byLease.get(hex(1))).toEqual({
      ...scope,
      clientId: "client-1",
      leaseId: hex(1),
      runId: "run-1",
      tenantId: principals.one,
    });
    expect(byLease.get(hex(2))).toEqual({
      ...scope,
      clientId: "client-2",
      leaseId: hex(2),
      runId: "run-2",
      tenantId: principals.one,
    });
  });

  it("a simlock lease from a plain client, with the edge on, ends with nothing sent to agent-device and its reclaim starts at once", async () => {
    const rig = await setUp();
    await plainLease(rig, "plain-1");
    const before = wipes(rig);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toEqual([]);
  });

  it("with capabilities.agent-device.enabled false, release-all reclaims at once, as today", async () => {
    const rig = await setUp({ enabled: false });
    await plainLease(rig, "plain-1");
    const before = wipes(rig);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(rig.fake.requests).toEqual([]);
  });

  it.each([
    {
      failure: "an error",
      fail: (rig: Rig) =>
        rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" }),
      tried: (rig: Rig, atRelease: readonly number[], before: number) => {
        expect(releasesReceived(rig)).toHaveLength(1);
        expect(atRelease).toEqual([before]);
      },
    },
    {
      failure: "an unreachable daemon",
      fail: (rig: Rig) => rig.fake.setUnreachable(true),
      tried: (rig: Rig) => {
        expect(rig.fake.refused).toContain("agent_device.lease.release");
      },
    },
  ])(
    "agent-device failing the release with $failure: the device's reclaim still starts",
    async ({ fail, tried }) => {
      const rig = await setUp();
      await granted(rig, 1);
      const before = wipes(rig);
      const atRelease = watchWipes(rig);
      fail(rig);

      await releaseAll(rig);

      await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
      tried(rig, atRelease, before);
    },
  );

  it("after the agent-device daemon restarts, release-all gets released false from it and the reclaim starts at once", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.restart();
    const before = wipes(rig);

    await releaseAll(rig);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(releasesReceived(rig)).toHaveLength(1);
    expect(rig.fake.releaseReplies).toHaveLength(1);
    expect(JSON.parse(rig.fake.releaseReplies[0] ?? "")).toMatchObject({
      result: { ok: true, released: false },
    });
  });

  it("after a simlock daemon restart on the same data directory, a lease made before the restart ends at startup with nothing sent to agent-device", async () => {
    const first = await setUp();
    await granted(first, 1, { ttlMs: 30_000 });

    const rig = await first.restart(() => first.clock.advance(60_000));

    await expect.poll(async () => await listed(rig)).toEqual([]);
    expect(releasesReceived(rig)).toEqual([]);
  });

  it("an allocate reply with a run ID of 129 characters, and one with a client ID holding `/`: the front releases the agent-device lease and the simlock lease and answers a COMMAND_FAILED error", async () => {
    const rig = await setUp();
    const good = await envelopeOf(await allocate(rig, 1));
    expect(good.result).toMatchObject({ ok: true });
    await release(rig, 1);

    for (const [n, edit] of [
      [2, { runId: "r".repeat(129) }],
      [3, { clientId: "client/1" }],
    ] as const) {
      rig.fake.editNextAllocateReply(edit);

      const answer = await envelopeOf(await allocate(rig, n));

      expect(answer.error?.data?.code).toBe("COMMAND_FAILED");
      await expect.poll(async () => await listed(rig)).toEqual([]);
      expect(rig.fake.leases.has(hex(n))).toBe(false);
    }
  });

  it("a lease ended by `nuke` sends nothing to agent-device", async () => {
    const rig = await setUp();
    await granted(rig, 1);

    await rig.daemon.dispatch("nuke.run", {}, adminSession);

    await sleep(100);
    expect(await listed(rig)).toEqual([]);
    expect(releasesReceived(rig)).toEqual([]);
  });

  it("a command held past lease.endWaitMs: the deletion starts at the ceiling and the host's release request is aborted; a second agent's open is granted a new device, not the one the held command ran on", async () => {
    const rig = await setUp({ endWaitMs: 30_000, maxRunning: 1 });
    await granted(rig, 1);
    const device = await grantedDevice(rig);
    await runningCommand(rig, 1);
    const before = wipes(rig);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    await advance(rig, 35_000, 5_000);

    await expect.poll(() => wipes(rig)).toBeGreaterThan(before);
    expect(rig.fake.abortedReleases).toEqual([hex(1)]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
    const second = await envelopeOf(await allocate(rig, 2, {}, { token: secrets.two }));
    expect(second.result).toMatchObject({ ok: true });
    expect(receivedAllocate(rig, 2)["udid"]).not.toBe(device.address);

    rig.fake.releaseCommand();
  });

  it("a daemon stop while the host waits for a release, with the held command set to outlive its HTTP request, aborts the participant's request and the stop finishes before the command is let go", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.keepCommandsAfterAbort();
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const stopped = track(rig.daemon.stop("test"));

    await expect.poll(() => stopped.done()).toBe(true);
    expect(rig.fake.abortedReleases).toEqual([hex(1)]);
  });

  it("`nuke.run` while the host waits for a release aborts that request and the reset goes on", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.keepCommandsAfterAbort();
    await runningCommand(rig, 1);
    await releaseAll(rig);
    await expect.poll(() => releasesReceived(rig).length).toBe(1);

    const reset = track(rig.daemon.dispatch("nuke.run", {}, adminSession));

    await expect.poll(() => reset.done()).toBe(true);
    expect(rig.fake.abortedReleases).toEqual([hex(1)]);
  });
});

describe("a worker's capabilities in status.get, through the whole worker daemon", () => {
  async function capabilities(rig: Rig) {
    return (await rig.daemon.dispatch("status.get", {}, adminSession)).capabilities;
  }

  it("a standalone worker with no capabilities.agent-device section answers status.get with capabilities [{name: agent-device, state: available}], and one with it false answers state off", async () => {
    const unset = await setUp({ enabled: "unset" });
    const off = await setUp({ enabled: false });
    const running = await setUp();

    expect(await capabilities(running)).toEqual([{ name: "agent-device", state: "available" }]);
    expect(await capabilities(unset)).toEqual([{ name: "agent-device", state: "available" }]);
    expect(await capabilities(off)).toEqual([{ name: "agent-device", state: "off" }]);
  });

  it.each(["found 0.20.1, need 0.21.28 or later", "starting"])(
    "a worker whose agent-device is unavailable with reason %s answers state unavailable with that reason",
    async (reason) => {
      const rig = await setUp();
      rig.fake.setUnavailable(reason);

      expect(await capabilities(rig)).toEqual([
        { name: "agent-device", reason, state: "unavailable" },
      ]);
    },
  );

  it("a worker whose agent-device is unavailable names the same reason in its front's notAvailable reply", async () => {
    const rig = await setUp();
    const reason = "found 0.20.1, need 0.21.28 or later";
    rig.fake.setUnavailable(reason);

    const health = await (await send(rig, "/health")).text();

    expect(health).toContain(`${notAvailable}${reason}`);
  });

  it("a worker whose agent-device goes from unavailable to running answers available on the next status.get", async () => {
    const rig = await setUp();
    rig.fake.setUnavailable("starting");
    expect((await capabilities(rig))?.[0]?.state).toBe("unavailable");

    rig.fake.setUnavailable(undefined);

    expect(await capabilities(rig)).toEqual([{ name: "agent-device", state: "available" }]);
  });

  it("a worker's own worker.list answer carries its capabilities", async () => {
    const rig = await setUp();

    const { workers } = await rig.daemon.dispatch("worker.list", {}, adminSession);

    expect(workers[0]?.capabilities).toEqual([{ name: "agent-device", state: "available" }]);
  });
});
