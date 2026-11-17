import { describe, expect, it } from "vitest";
import {
  heartbeat,
  advance,
  release,
  track,
  listed,
  type DispatchTap,
  tapDispatch,
  runningCommand,
} from "./test-edge.js";
import {
  secrets,
  principals,
  defaultTtlMs,
  maxTtlMs,
  scope,
  adminSession,
  sessionFor,
  type Rig,
  sleep,
  setUp,
  envelopeOf,
  hex,
  allocate,
  granted,
  command,
  leases,
  allocatesReceived,
  refusal,
} from "./test-support.js";
import { expectEndedBySimlock, expectLeaseGone } from "./test-edge-front.js";

function heartbeatsReceived(rig: Rig): number {
  return rig.fake.rpcRequests("agent_device.lease.heartbeat").length;
}

// why: a lease the front asked for in this process, whose CLI hung up and whose agent-device release failed, stays in simlock with agent-device still holding it, and the front map has no entry for it.
async function keptWhileAgentDeviceHolds(rig: Rig, n: number): Promise<void> {
  const releases = rig.fake.rpcRequests("agent_device.lease.release").length;
  rig.fake.holdAllocate();
  rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
  const hangUp = new AbortController();
  const pending = track(allocate(rig, n, { ttlMs: 60_000 }, { signal: hangUp.signal }));
  await expect.poll(() => allocatesReceived(rig, n).length).toBe(1);
  hangUp.abort();
  await pending.promise.catch(() => undefined);
  await sleep(50);
  rig.fake.letAllocateGo();
  await expect
    .poll(() => rig.fake.rpcRequests("agent_device.lease.release").length)
    .toBe(releases + 1);
}

async function deadlineOf(rig: Rig, n: number): Promise<number | undefined> {
  return (await leases(rig)).find((lease) => lease.id === hex(n))?.ttlDeadline;
}

function frontCalls(tap: DispatchTap): readonly string[] {
  return tap.operations.filter((name) => name === "lease.renew" || name === "lease.list");
}

async function renewMessage(rig: Rig, leaseId: string, ttlMs: number): Promise<string> {
  try {
    await rig.daemon.dispatch("lease.renew", { leaseId, ttlMs }, sessionFor(principals.one));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("simlock accepted a renewal the test expected it to refuse");
}

describe("the agent-device front, through the whole worker daemon", () => {
  it("a heartbeat reaches the agent-device daemon before simlock, carrying `ttlMs` equal to the ceiling, and once it answers, the simlock lease's deadline is now plus the CLI's `ttlMs`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const allocated = await deadlineOf(rig, 1);
    let deadlineAtDaemon: number | undefined;
    rig.fake.onHeartbeat = async () => {
      deadlineAtDaemon = await deadlineOf(rig, 1);
    };
    await advance(rig, 10_000);

    const answer = await envelopeOf(
      await heartbeat(rig, 1, { ttlMs: 120_000 }, { token: secrets.one }),
    );

    expect(answer.result).toMatchObject({ ok: true });
    expect(deadlineAtDaemon).toBe(allocated);
    expect(rig.fake.rpcRequests("agent_device.lease.heartbeat")[0]?.params).toMatchObject({
      ...scope,
      leaseId: hex(1),
      ttlMs: rig.fake.leaseMaxTtlMs,
    });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 120_000);
  });

  it.each([
    { cap: undefined, expected: 300_000, row: "300000 with no cap", sent: 300_000 },
    { cap: 10_000, expected: 10_000, row: "300000 with cap 10000", sent: 300_000 },
    { cap: 600_000, expected: 300_000, row: "300000 with cap 600000", sent: 300_000 },
    { cap: 10_000, expected: 10_000, row: "none with cap 10000", sent: undefined },
    { cap: undefined, expected: defaultTtlMs, row: "none with no cap", sent: undefined },
    { cap: undefined, expected: 5_000, row: "1 with no cap", sent: 1 },
  ])(
    "a CLI `ttlMs` of $row gives the simlock lease, its heartbeat renewal and its renewal interval a TTL of $expected ms",
    async ({ cap, expected, sent }) => {
      const rig = await setUp(cap === undefined ? {} : { leaseTtlCapMs: cap });
      const ttl = expected as number;
      await granted(rig, 1, { ttlMs: sent });
      expect((await leases(rig))[0]?.ttlMs).toBe(ttl);
      await advance(rig, 1_000);

      const answer = await envelopeOf(
        await heartbeat(rig, 1, sent === undefined ? {} : { ttlMs: sent }),
      );

      expect(answer.result).toMatchObject({ ok: true });
      expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + ttl);
      const settled = await deadlineOf(rig, 1);
      await runningCommand(rig, 1);
      await advance(rig, Math.floor(ttl / 3) - 700, 500);
      expect(await deadlineOf(rig, 1)).toBe(settled);
      await advance(rig, 1_400, 500);
      const renewed = (await deadlineOf(rig, 1)) as number;
      expect(renewed).toBeGreaterThan(settled as number);
      expect(renewed - (settled as number)).toBeLessThanOrEqual(ttl / 3 + 700);
    },
    60_000,
  );

  it("a heartbeat with a longer `ttlMs` than the allocate's moves the deadline to now plus that TTL, and a following heartbeat with no `ttlMs` renews with it too", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await advance(rig, 5_000);

    await heartbeat(rig, 1, { ttlMs: 300_000 });

    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 300_000);
    await advance(rig, 20_000);

    await heartbeat(rig, 1);

    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 300_000);
    expect((await leases(rig))[0]?.ttlMs).toBe(300_000);
  });

  it("after the agent's own `simlock lease renew` with a longer TTL, a heartbeat and a running command's renewals leave that later deadline in place", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await rig.daemon.dispatch(
      "lease.renew",
      { leaseId: hex(1), ttlMs: 900_000 },
      sessionFor(principals.one),
    );
    const later = await deadlineOf(rig, 1);
    expect(later).toBe(rig.clock.now() + 900_000);
    await advance(rig, 5_000);

    await heartbeat(rig, 1, { ttlMs: 120_000 });

    expect(await deadlineOf(rig, 1)).toBe(later);
    const running = await runningCommand(rig, 1);
    await advance(rig, 130_000, 5_000);
    expect(await deadlineOf(rig, 1)).toBe(later);
    rig.fake.releaseCommand();
    await running.promise;
    await expect.poll(() => running.done()).toBe(true);
    expect(await deadlineOf(rig, 1)).toBe(later);
  });

  it("a heartbeat the agent-device daemon cannot answer returns that error and leaves the simlock lease's deadline where it was", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);
    rig.fake.failNextHeartbeat({ code: "COMMAND_FAILED", message: "daemon is busy" });

    const failed = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon is busy",
    });
    expect(await deadlineOf(rig, 1)).toBe(before);

    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(unreachable.error).toBeDefined();
    expect(unreachable.result).toBeUndefined();
    expect(await deadlineOf(rig, 1)).toBe(before);

    rig.fake.setUnreachable(false);
    await heartbeat(rig, 1, { ttlMs: 60_000 });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 60_000);
  });

  it("with no cap set, a heartbeat whose `ttlMs` is above `lease.maxTtlMs` answers `COMMAND_FAILED` with simlock's `BAD_REQUEST` message and leaves the deadline where it was, and a following heartbeat with a valid `ttlMs` renews the lease", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);
    const message = await renewMessage(rig, hex(1), maxTtlMs + 1);

    const refused = await envelopeOf(await heartbeat(rig, 1, { ttlMs: maxTtlMs + 1 }));

    expect(refused.error).toMatchObject({ data: { code: "COMMAND_FAILED" }, message });
    expect(await deadlineOf(rig, 1)).toBe(before);

    const renewed = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

    expect(renewed.result).toMatchObject({ ok: true });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 120_000);
    expect((await leases(rig))[0]?.ttlMs).toBe(120_000);
  });

  it("a heartbeat for a lease the agent released through the front answers `LEASE_NOT_FOUND`, and a following allocate gets a new lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await release(rig, 1);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectLeaseGone(answer, "LEASE_NOT_FOUND");
    expect(await listed(rig)).toEqual([]);

    await granted(rig, 2);

    expect(await listed(rig)).toEqual([hex(2)]);
  });

  it("one TTL after the agent's release, a heartbeat for that lease answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await release(rig, 1);
    expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
    await advance(rig, 61_000, 5_000);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
  });

  it.each([
    [
      "`simlock release --all`",
      5_000,
      async (rig: Rig) => {
        await rig.daemon.dispatch("lease.release-all", {}, adminSession);
      },
    ],
    [
      "expiry",
      5_000,
      async (rig: Rig) => {
        await advance(rig, 6_000);
      },
    ],
    [
      "the device is lost",
      600_000,
      async (rig: Rig) => {
        rig.driver.setManagedReality({ devices: [], processes: [] });
        await advance(rig, 120_000, 10_000);
      },
    ],
  ])(
    "after %s, a heartbeat for the lease answers `LEASE_ENDED_BY_HOST` with the message and reason, and makes no new simlock lease",
    async (_cause, ttl, end) => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: ttl });
      await end(rig);
      await expect.poll(() => listed(rig)).toEqual([]);

      const answer = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 5_000 }));

      expectEndedBySimlock(answer);
      expect(await listed(rig)).toEqual([]);
    },
  );

  it.each([
    [
      "`LEASE_NOT_FOUND` with the simlock lease already released",
      async (rig: Rig) => {
        await rig.daemon.dispatch("lease.release-all", {}, adminSession);
        expect(await listed(rig)).toEqual([]);
      },
    ],
    [
      "`LEASE_EXPIRED`",
      async (rig: Rig) => {
        rig.fake.loseLease(hex(1), "LEASE_EXPIRED");
        expect(await listed(rig)).toEqual([hex(1)]);
      },
    ],
    [
      "`LEASE_REVOKED`",
      async (rig: Rig) => {
        rig.fake.loseLease(hex(1), "LEASE_REVOKED");
        expect(await listed(rig)).toEqual([hex(1)]);
      },
    ],
  ] as const)(
    "a heartbeat the agent-device daemon answers with %s, for a lease that really ended, releases the simlock lease and answers `LEASE_ENDED_BY_HOST`",
    async (_case, end) => {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      await end(rig);

      const answer = await envelopeOf(await heartbeat(rig, 1));

      expectEndedBySimlock(answer);
      expect(await listed(rig)).toEqual([]);
    },
  );

  it("a heartbeat naming a lease ID the front map lacks, which simlock kept while agent-device still holds it: it is released with the heartbeat's scope first, then the simlock lease; when agent-device is unreachable, neither lease is touched; each answers as in the table", async () => {
    const rig: Rig = await setUp();
    await keptWhileAgentDeviceHolds(rig, 2);
    await keptWhileAgentDeviceHolds(rig, 3);
    expect(await listed(rig)).toEqual([hex(2), hex(3)]);

    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = await listed(rig);
    };
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 2)));
    expect(heldAtDaemonRelease).toEqual([hex(2), hex(3)]);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject(scope);
    expect(rig.fake.leases.has(hex(2))).toBe(false);
    expect(await listed(rig)).toEqual([hex(3)]);

    const before = await deadlineOf(rig, 3);
    await advance(rig, 10_000);
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await heartbeat(rig, 3));
    rig.fake.setUnreachable(false);

    expect(unreachable.error).toBeDefined();
    expect(unreachable.error?.data?.code).not.toBe("UNAUTHORIZED");
    expect(await listed(rig)).toEqual([hex(3)]);
    expect(await deadlineOf(rig, 3)).toBe(before);
    expect(rig.fake.leases.has(hex(3))).toBe(true);
  });

  it("a heartbeat from a second token naming the first token's lease ID answers `LEASE_ENDED_BY_HOST`, and the first token's lease is neither released nor renewed", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);

    const answer = await envelopeOf(
      await heartbeat(rig, 1, { ttlMs: 60_000 }, { token: secrets.two }),
    );

    expectEndedBySimlock(answer);
    expect(await listed(rig)).toEqual([hex(1)]);
    expect(await deadlineOf(rig, 1)).toBe(before);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    const own = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(own.result).toMatchObject({ ok: true });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 60_000);
  });

  it("a heartbeat naming a lease ID the front map lacks, when the agent-device daemon fails to release its lease, answers that error and leaves the simlock lease in place", async () => {
    const rig: Rig = await setUp();
    await keptWhileAgentDeviceHolds(rig, 1);
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon cannot release" });

    const failed = await envelopeOf(await heartbeat(rig, 1));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon cannot release",
    });
    expect(await listed(rig)).toEqual([hex(1)]);
  });

  it("a heartbeat for a lease the agent-device daemon lost, when simlock cannot release its lease, answers `COMMAND_FAILED` with simlock's message and marks nothing, and the next heartbeat releases it and answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.loseLease(hex(1), "LEASE_EXPIRED");
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.release");

    const failed = await envelopeOf(await heartbeat(rig, 1));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "simlock could not do that",
    });
    expect(await listed(rig)).toEqual([hex(1)]);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([]);
  });

  it.each([0, -5, "soon", true])(
    "a heartbeat with a `ttlMs` of %j is refused with `ttlMs must be a positive number of milliseconds`, and neither daemon is reached",
    async (ttlMs) => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      const before = await deadlineOf(rig, 1);
      const received = heartbeatsReceived(rig);
      await advance(rig, 10_000);

      const refused = await envelopeOf(await heartbeat(rig, 1, { ttlMs }));

      expect(refused.error).toMatchObject(
        refusal("refused: ttlMs must be a positive number of milliseconds"),
      );
      expect(heartbeatsReceived(rig)).toBe(received);
      expect(await deadlineOf(rig, 1)).toBe(before);
    },
  );

  it("after a heartbeat answered `LEASE_ENDED_BY_HOST` because simlock ended the lease, the next heartbeat answers it again and the agent-device daemon receives nothing for it", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    const received = rig.fake.requests.length;

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("a lease released through the front while a command runs stays ended by the agent: a renewal that fires between the simlock release and the end of the agent's release, and the command's final renewal, mark nothing, and the next heartbeat still answers `LEASE_NOT_FOUND`", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const running = await runningCommand(rig, 1);
    const tap = tapDispatch(rig);
    tap.afterNext("lease.release", async () => {
      await advance(rig, 12_000, 4_000);
    });

    rig.fake.answerReleaseWhileCommandsRun();

    const released = await envelopeOf(await release(rig, 1));
    rig.fake.releaseCommand();
    await running.promise;

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(await listed(rig)).toEqual([]);
    expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
  });

  it("after `simlock release --all`, the agent's release answers success, a heartbeat for the old ID then answers `LEASE_ENDED_BY_HOST` (ended by simlock, not `LEASE_NOT_FOUND`), and the next allocate gets a new lease; an entry found unlisted by another allocate's check answers its next heartbeat `LEASE_ENDED_BY_HOST` without reaching the agent-device daemon", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: false });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    await granted(rig, 2);
    expect(await listed(rig)).toEqual([hex(2)]);

    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await advance(rig, 125_000, 25_000);
    await granted(rig, 3);
    const received = heartbeatsReceived(rig);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 2)));
    expect(heartbeatsReceived(rig)).toBe(received);
  });

  it("after `simlock release --all` and the agent's release, a heartbeat answers `LEASE_ENDED_BY_HOST` without reaching the agent-device daemon, and a running command's renewals stop", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    rig.fake.answerReleaseWhileCommandsRun();
    await release(rig, 1);
    const received = rig.fake.requests.length;
    const tap = tapDispatch(rig);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    await advance(rig, 120_000, 10_000);

    expect(rig.fake.requests).toHaveLength(received);
    rig.fake.releaseCommand();
    expect(tap.operations).not.toContain("lease.list");
    expect(tap.operations).not.toContain("lease.renew");
  });

  it("a release for a lease simlock ended answers the agent-device daemon's reply as a success, and the agent-device lease is released", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    const tap = tapDispatch(rig);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: false });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(tap.operations).not.toContain("lease.release");
  });

  it("while a command for the lease runs longer than its TTL, the simlock lease is renewed every TTL/3 and does not expire", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    const tap = tapDispatch(rig);
    const deadlines: (number | undefined)[] = [];

    for (let tick = 0; tick < 9; tick += 1) {
      await advance(rig, 10_000, 5_000);
      deadlines.push(await deadlineOf(rig, 1));
    }

    expect(deadlines.every((deadline) => deadline !== undefined)).toBe(true);
    expect(deadlines.at(-1)).toBeGreaterThan(rig.clock.now());
    expect(new Set(deadlines).size).toBeGreaterThan(5);
    const checks = tap.operations.filter((name) => name === "lease.list").length;
    expect(checks).toBeGreaterThanOrEqual(8);
    expect(checks).toBeLessThanOrEqual(9);
  });

  it("a command that runs on past `lease.maxTtlMs` stops counting as running: its renewals stop, and the lease is no longer kept", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const tap = tapDispatch(rig);
    await runningCommand(rig, 1);

    await advance(rig, maxTtlMs + 400_000, 100_000);
    const calls = frontCalls(tap).length;
    await advance(rig, 1_000_000, 100_000);

    expect(calls).toBeGreaterThan(0);
    expect(frontCalls(tap)).toHaveLength(calls);
    expect(await listed(rig)).toEqual([]);
  }, 60_000);

  it("when the command ends, the lease is renewed once more, and its deadline does not move again over the next TTL", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const running = await runningCommand(rig, 1);
    await advance(rig, 25_000, 5_000);
    rig.fake.releaseCommand();
    await running.promise;

    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const final = await deadlineOf(rig, 1);
    await advance(rig, 29_000, 5_000);

    expect(await deadlineOf(rig, 1)).toBe(final);
  });

  it("a command agent-device answers with a 5xx reaches the CLI unchanged", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextCommandWithStatus(500, "snapshot runner crashed");

    const response = await command(rig, "snapshot", 1);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot runner crashed");
  });

  it("a command that fails, and one whose CLI hangs up, stop the renewals the same way", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await granted(rig, 2, { ttlMs: 30_000 });
    rig.fake.failNextCommand({ code: "COMMAND_FAILED", message: "the command failed" });
    const failing = await runningCommand(rig, 1);
    await advance(rig, 15_000, 5_000);
    rig.fake.releaseCommand();
    const failure = await envelopeOf(await failing.promise);
    expect(failure.error).toMatchObject({ message: "the command failed" });
    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const afterFailure = await deadlineOf(rig, 1);

    const hangUp = new AbortController();
    const hanging = await runningCommand(rig, 2, { signal: hangUp.signal });
    await advance(rig, 15_000, 5_000);
    hangUp.abort();
    await hanging.promise.catch(() => undefined);
    await expect.poll(() => deadlineOf(rig, 2)).toBe(rig.clock.now() + 30_000);
    const afterHangUp = await deadlineOf(rig, 2);

    await advance(rig, 14_000, 2_000);
    expect(await deadlineOf(rig, 1)).toBe(afterFailure);
    expect(await deadlineOf(rig, 2)).toBe(afterHangUp);
  });

  it("with two overlapping commands on one lease, renewals go on until the second one ends", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const firstHangUp = new AbortController();
    await runningCommand(rig, 1, { signal: firstHangUp.signal });
    const second = await runningCommand(rig, 1);
    await advance(rig, 20_000, 5_000);
    firstHangUp.abort();

    await advance(rig, 40_000, 5_000);

    expect(await deadlineOf(rig, 1)).toBeGreaterThan(rig.clock.now());
    rig.fake.releaseCommand();
    await second.promise;
    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const final = await deadlineOf(rig, 1);
    await advance(rig, 29_000, 5_000);
    expect(await deadlineOf(rig, 1)).toBe(final);
  });

  it("a renewal that fails because simlock ended the lease mid-command stops the renewals, and the command's reply still reaches the CLI; a renewal refused for another reason is tried again at the next tick", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const tap = tapDispatch(rig);
    const running = await runningCommand(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await advance(rig, 15_000, 5_000);
    const calls = frontCalls(tap).length;

    await advance(rig, 60_000, 5_000);

    expect(frontCalls(tap)).toHaveLength(calls);
    rig.fake.releaseCommand();
    const reply = await envelopeOf(await running.promise);
    expect(reply.result).toMatchObject({ command: "snapshot", ok: true });
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    await granted(rig, 2, { ttlMs: 30_000 });
    const started = await deadlineOf(rig, 2);
    await runningCommand(rig, 2);
    tap.rejectNext("lease.renew");
    await advance(rig, 11_000, 1_000);
    expect(await deadlineOf(rig, 2)).toBe(started);

    await advance(rig, 10_000, 1_000);

    expect(await deadlineOf(rig, 2)).toBeGreaterThan(started as number);
  });

  it('an agent release whose `lease.release` simlock refuses with another error clears "release in progress": the simlock lease stays, and a later renewal that finds it gone marks it ended by simlock', async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.release");

    const refused = await envelopeOf(await release(rig, 1));

    expect(refused.result).toMatchObject({ ok: true });
    expect(await listed(rig)).toEqual([hex(1)]);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectEndedBySimlock(answer);
    const received = heartbeatsReceived(rig);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(heartbeatsReceived(rig)).toBe(received);
  });

  it("a heartbeat lowering the TTL from 300 s to 5 s while a command runs re-arms the renewals, and the lease does not expire before the command ends", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 300_000 });
    await runningCommand(rig, 1);
    await advance(rig, 1_000);

    await heartbeat(rig, 1, { ttlMs: 5_000 });

    await advance(rig, 360_000, 2_000);
    expect(await listed(rig)).toEqual([hex(1)]);
    expect(await deadlineOf(rig, 1)).toBeGreaterThan(rig.clock.now());
  }, 60_000);

  it("a command naming a lease ID the front map does not hold for its token, or the lease of an ended entry, starts no renewals", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await granted(rig, 2, { ttlMs: 30_000 });
    await release(rig, 2);
    const tap = tapDispatch(rig);
    await runningCommand(rig, 1, { token: secrets.two });
    await runningCommand(rig, 2);

    await advance(rig, 40_000, 5_000);

    expect(frontCalls(tap)).toEqual([]);
    expect(await listed(rig)).toEqual([]);
  });

  it("a release through the front while a command runs stops that lease's renewals", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await advance(rig, 5_000, 5_000);
    rig.fake.answerReleaseWhileCommandsRun();
    await release(rig, 1);
    const tap = tapDispatch(rig);

    await advance(rig, 60_000, 5_000);

    expect(frontCalls(tap)).toEqual([]);
    rig.fake.releaseCommand();
  });

  it("a lease whose CLI stops sending heartbeats expires one TTL after its last heartbeat, and its device can be leased again", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: 30_000 });
    await advance(rig, 10_000, 5_000);
    await heartbeat(rig, 1, { ttlMs: 30_000 });
    await advance(rig, 29_000, 5_000);
    expect(await listed(rig)).toEqual([hex(1)]);

    await advance(rig, 3_000, 1_000);

    expect(await listed(rig)).toEqual([]);
    await granted(rig, 2);
    expect(await listed(rig)).toEqual([hex(2)]);
  });

  it("after the same restart (same `FakeDriver`, lease still listed), a release for a lease made before the restart answers the agent-device daemon's reply as a success and releases that simlock lease", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1)]);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(await listed(rig)).toEqual([]);
  });

  it("a release with no map entry from a second token, naming the first token's lease ID, answers the agent-device daemon's reply and leaves the first token's simlock lease in place", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig: Rig = await first.restart();
    rig.fake.letAnyTenantRelease();

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(await listed(rig)).toEqual([hex(1)]);
  });

  it("stopping the daemon while a command runs renews nothing once the stop began: the lease's deadline, read after a restart on the same data directory and the same `FakeDriver` (the lease still listed), is the one it had before the stop", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await advance(rig, 12_000, 4_000);
    const before = await deadlineOf(rig, 1);
    const tap = tapDispatch(rig);

    const stopping = rig.daemon.stop("test");
    await advance(rig, 3_000, 1_000).catch(() => undefined);
    await stopping;
    expect(frontCalls(tap)).toEqual([]);
    const restarted = await rig.restart();

    expect(await listed(restarted)).toEqual([hex(1)]);
    expect(await deadlineOf(restarted, 1)).toBe(before);
  });
});
