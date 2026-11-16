import { describe, expect, it } from "vitest";
import { DispatchError } from "../daemon/dispatch.js";
import { readHistoryEvents } from "../history/testing.js";
import {
  runningDaemons,
  secrets,
  principals,
  notAvailable,
  holderCannot,
  tooOld,
  workerCeilingMs,
  scope,
  adminSession,
  sessionFor,
  Member,
  Rig,
  sleep,
  setUp,
  turn,
  advance,
  send,
  envelopeOf,
  hex,
  allocate,
  grantedOnGateway,
  release,
  heartbeat,
  command,
  workerLeases,
  fleetLeases,
  waiting,
  workerLeaseFor,
  deadlineOf,
  tenantOf,
  grantedDevice,
  deviceStates,
  track,
  expectEndedBySimlock,
  tapDispatch,
  interceptRelay,
  relayFailsWith,
  wipes,
  heartbeatsReceived,
  allocatesReceived,
  runningCommand,
  first,
  leaveOutOfNextListing,
} from "./test-gateway.js";
import { listedByGateway } from "./test-gateway-front.js";

describe("the agent-device front, through a gateway", { timeout: 60_000 }, () => {
  it("with every matching device leased, allocate waits and is granted once one is released", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 1 }] });
    await grantedOnGateway(rig, 1);

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await expect.poll(() => waiting(rig)).toEqual([hex(2)]);
    expect(second.done()).toBe(false);

    await release(rig, 1);
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ data: { lease: { leaseId: hex(2) } }, ok: true });
    await expect
      .poll(async () => (await fleetLeases(rig, principals.two)).map((lease) => lease.id))
      .toEqual([hex(2)]);
  });

  it("a CLI that hangs up while its allocate waits leaves the gateway's queue, and nothing is granted later", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 1 }] });
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    const hangUp = new AbortController();
    const second = track(allocate(rig, 2, {}, { signal: hangUp.signal, token: secrets.two }));
    await expect.poll(() => waiting(rig)).toEqual([hex(2)]);

    hangUp.abort();
    await second.promise.catch(() => undefined);
    await expect.poll(() => waiting(rig)).toEqual([]);
    await release(rig, 1);
    await sleep(100);

    expect(await fleetLeases(rig, principals.two)).toEqual([]);
    expect(await workerLeases(member)).toEqual([]);
    expect(allocatesReceived(member, 2)).toEqual([]);
  });

  it("a command for the lease reaches that worker's agent-device daemon with the prefixed tenant, and its streamed reply reaches the CLI unchanged", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    const chunks = [
      '{"type":"progress","event":{"kind":"command","message":"one"}}\n',
      '{"type":"progress","event":{"kind":"command","message":"two"}}\n',
      '{"type":"response","response":{"jsonrpc":"2.0","id":"x","result":{"ok":true,"data":{}}}}\n',
    ];
    member.fake.streamNextCommand(chunks);

    const streamed = await command(rig, "snapshot", 1);

    expect(await streamed.text()).toBe(chunks.join(""));
    expect(
      member.fake.rpcRequests("agent_device.command").map((request) => request.tenant),
    ).toEqual([await tenantOf(member, 1)]);
  });

  it("a heartbeat reaches the worker's agent-device daemon first, then renews the simlock lease to now plus its `ttlMs`", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1, { ttlMs: 60_000 });
    const allocated = await deadlineOf(member, 1);
    let deadlineAtDaemon: number | undefined;
    member.fake.onHeartbeat = async () => {
      deadlineAtDaemon = await deadlineOf(member, 1);
    };
    await advance(rig, 10_000, 5_000);

    const answer = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

    expect(answer.result).toMatchObject({ ok: true });
    expect(deadlineAtDaemon).toBe(allocated);
    expect(member.fake.rpcRequests("agent_device.lease.heartbeat")[0]?.params).toMatchObject({
      ...scope,
      leaseId: hex(1),
      ttlMs: workerCeilingMs,
    });
    expect(await deadlineOf(member, 1)).toBe(rig.clock.now() + 120_000);
  });

  it("a heartbeat for a lease whose worker stopped being capable answers the notAvailable reply naming `the worker holding this lease cannot serve agent-device`", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
    await turn(rig, member, "unavailable");
    const received = heartbeatsReceived(member);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expect(answer.error?.message).toBe(`${notAvailable}${holderCannot}`);
    expect(heartbeatsReceived(member)).toBe(received);
  });

  it("while a command runs longer than the TTL, the simlock lease is renewed every TTL/3 through the gateway and does not expire", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, member, 1);
    const tap = tapDispatch(rig.gateway);
    const deadlines: (number | undefined)[] = [];

    for (let tick = 0; tick < 9; tick += 1) {
      await advance(rig, 10_000, 5_000);
      await sleep(30);
      deadlines.push(await deadlineOf(member, 1));
    }

    expect(deadlines.every((deadline) => deadline !== undefined)).toBe(true);
    expect(deadlines.at(-1)).toBeGreaterThan(rig.clock.now());
    expect(new Set(deadlines).size).toBeGreaterThan(4);
    expect(tap.operations.filter((name) => name === "lease.renew").length).toBeGreaterThanOrEqual(
      7,
    );
    member.fake.releaseCommand();
  });

  it("release goes to the worker's agent-device daemon first, then releases the simlock lease, and the device is deleted and the pool makes a ready one", async () => {
    const rig = await setUp();
    const member = first(rig);
    let heldAtDaemonRelease: readonly string[] = [];
    member.fake.onRelease = async () => {
      heldAtDaemonRelease = (await workerLeases(member)).map((lease) => lease.requesterId);
    };
    await grantedOnGateway(rig, 1);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(heldAtDaemonRelease).toHaveLength(1);
    expect(await workerLeases(member)).toEqual([]);
    await expect.poll(() => deviceStates(member)).toEqual(["ready"]);
    expect(await fleetLeases(rig)).toEqual([]);
  });

  it("a release the agent-device daemon fails keeps the simlock lease", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    member.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon could not release" });

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon could not release",
    });
    expect(await workerLeases(member)).toHaveLength(1);
    expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("after gateway release or expiry, boot is refused locally; release reaches agent-device before the wipe and heartbeat answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig = await setUp();
    const member = first(rig);
    const wipesAtRelease: number[] = [];
    member.fake.onRelease = async () => {
      wipesAtRelease.push(wipes(member));
    };
    await grantedOnGateway(rig, 1);
    const before = wipes(member);

    await rig.gateway.dispatch("lease.release-all", {}, adminSession);

    await expect.poll(() => member.fake.rpcRequests("agent_device.lease.release").length).toBe(1);
    expect(wipesAtRelease).toEqual([before]);
    const received = heartbeatsReceived(member);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    expect(heartbeatsReceived(member)).toBe(received + 1);

    const bootRig = await setUp();
    const bootMember = first(bootRig);
    await grantedOnGateway(bootRig, 1);
    await listedByGateway(bootRig, 1);
    expect((await envelopeOf(await command(bootRig, "boot", 1))).result).toMatchObject({
      ok: true,
    });
    await bootRig.gateway.dispatch("lease.release-all", {}, adminSession);
    const commands = bootMember.fake.rpcRequests("agent_device.command").length;
    expectEndedBySimlock(await envelopeOf(await command(bootRig, "boot", 1)));
    expect(bootMember.fake.rpcRequests("agent_device.command")).toHaveLength(commands);

    await grantedOnGateway(bootRig, 2, { ttlMs: 5_000 });
    await listedByGateway(bootRig, 1);
    const address = (await grantedDevice(bootMember)).address;
    expect((await envelopeOf(await command(bootRig, "boot", 2))).result).toMatchObject({
      ok: true,
    });
    await advance(bootRig, 6_000, 1_000);
    await expect.poll(() => fleetLeases(bootRig)).toEqual([]);
    const afterExpiry = bootMember.fake.rpcRequests("agent_device.command").length;
    expectEndedBySimlock(
      await envelopeOf(await command(bootRig, "boot", 2, {}, { flags: { udid: address } })),
    );
    expect(bootMember.fake.rpcRequests("agent_device.command")).toHaveLength(afterExpiry);
  });

  it("a command with no device selector naming a lease id another token holds, and one the gateway does not know, answer `refused: lease <id> is not one of yours on this gateway` with status 403, and no worker receives it; with `--udid`, the same command answers `refused: simlock picks the device`, as on a worker", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    const own = await envelopeOf(await command(rig, "snapshot", 1));
    expect(own.result).toMatchObject({ ok: true });
    const received = member.fake.rpcRequests("agent_device.command").length;

    const other = await command(rig, "snapshot", 1, { token: secrets.two });
    // why: within 60 s of the gateway starting, a lease it does not know answers "try again" (#517); past that, a refusal.
    rig.clock.advance(60_000);
    const unknown = await command(rig, "snapshot", 9);

    expect(other.status).toBe(403);
    expect((await envelopeOf(other)).error?.message).toBe(
      `refused: lease ${hex(1)} is not one of yours on this gateway`,
    );
    expect(unknown.status).toBe(403);
    expect((await envelopeOf(unknown)).error?.message).toBe(
      `refused: lease ${hex(9)} is not one of yours on this gateway`,
    );
    const picked = await envelopeOf(
      await command(rig, "snapshot", 1, { token: secrets.two }, { flags: { udid: "ABC" } }),
    );
    expect(picked.error?.message).toBe("refused: simlock picks the device");
    expect(member.fake.rpcRequests("agent_device.command").length).toBe(received);
  });

  it("after `simlock release --all`, once the fake clock has moved the gateway's `lease.maxTtlMs` plus 1 s past the index's removal of the lease, the link's memory no longer holds it, and a heartbeat for it answers `refused: lease <id> is not one of yours on this gateway`; one second before that, the heartbeat is still relayed", async () => {
    const options = { defaultTtlMs: 60_000, maxTtlMs: 120_000 } as const;
    const early = await setUp(options);
    const earlyMember = first(early);
    await grantedOnGateway(early, 1, { ttlMs: 30_000 });
    await early.gateway.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(async () => (await fleetLeases(early)).length).toBe(0);
    await advance(early, 119_000, 10_000);
    const received = heartbeatsReceived(earlyMember);

    expectEndedBySimlock(await envelopeOf(await heartbeat(early, 1)));
    expect(heartbeatsReceived(earlyMember)).toBe(received + 1);

    const late = await setUp(options);
    const lateMember = first(late);
    await grantedOnGateway(late, 1, { ttlMs: 30_000 });
    await late.gateway.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(async () => (await fleetLeases(late)).length).toBe(0);
    await advance(late, 121_000, 10_000);
    const lateReceived = heartbeatsReceived(lateMember);

    const answer = await envelopeOf(await heartbeat(late, 1));

    expect(answer.error?.message).toBe(
      `refused: lease ${hex(1)} is not one of yours on this gateway`,
    );
    expect(heartbeatsReceived(lateMember)).toBe(lateReceived);
  });

  it("a request with no lease id other than `/health` is refused with `refused: this agent-device is too old to use through a gateway; update it`", async () => {
    const rig = await setUp();
    const member = first(rig);
    expect((await send(rig, "/health")).status).toBe(200);
    const before = member.fake.requests.length;

    const bare = await envelopeOf(await command(rig, "snapshot", undefined));
    const upload = await send(rig, "/upload/preflight", { body: "{}" });

    expect(bare.error?.message).toBe(tooOld);
    expect(await upload.text()).toContain(tooOld);
    expect(member.fake.requests.length).toBe(before);
  });

  it("`capabilities.agent-device.leaseTtlCapMs` on the gateway caps the TTL of a lease made through it", async () => {
    const rig = await setUp({ leaseTtlCapMs: 10_000 });
    const member = first(rig);

    await grantedOnGateway(rig, 1, { ttlMs: 300_000 });

    expect((await workerLeaseFor(member, 1)).ttlMs).toBe(10_000);
    await expect.poll(async () => (await fleetLeases(rig))[0]?.ttlMs).toBe(10_000);
  });

  it("stopping the gateway while an allocate waits ends its lease request `cancelled`, not `DAEMON_STOPPING`, and a running command's renewals stop", async () => {
    const rig = await setUp({ workers: [{ label: "w1", maxRunning: 1 }] });
    const member = first(rig);
    await grantedOnGateway(rig, 1, { ttlMs: 30_000 }, { token: secrets.two });
    await runningCommand(rig, member, 1, { token: secrets.two });
    const tap = tapDispatch(rig.gateway);
    await advance(rig, 20_000, 5_000);
    const renewedBefore = tap.operations.filter((name) => name === "lease.renew").length;
    const second = track(allocate(rig, 2));
    await expect.poll(() => waiting(rig)).toEqual([hex(2)]);

    await rig.gateway.stop("test");
    await second.promise.catch(() => undefined);
    const afterStop = tap.operations.length;
    await advance(rig, 60_000, 10_000);

    expect(renewedBefore).toBeGreaterThan(0);
    expect(tap.operations.length).toBe(afterStop);
    const lines = (await readHistoryEvents(rig.directory)) as Array<{
      event?: string;
      payload?: Record<string, unknown>;
    }>;
    expect(
      lines.filter(
        (entry) =>
          entry.event === "lease.rejected" &&
          entry.payload?.["requester"] === hex(2) &&
          entry.payload["reason"] === "cancelled",
      ),
    ).toHaveLength(1);
    member.fake.releaseCommand();
  });

  it("a heartbeat, a command, a release and an allocate whose relay fails with `RELAY_TARGET_MISSING` answer the notAvailable reply with that message, and the failed allocate leaves no lease", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    const missing = `${notAvailable}no relay target agent-device on this worker`;
    expect((await envelopeOf(await command(rig, "snapshot", 1))).result).toMatchObject({
      ok: true,
    });
    relayFailsWith(rig, "RELAY_TARGET_MISSING", "no relay target agent-device on this worker");

    const beat = await heartbeat(rig, 1);
    const commanded = await command(rig, "snapshot", 1);
    const released = await release(rig, 1);
    const made = await allocate(rig, 2);

    expect((await envelopeOf(beat)).error?.message).toBe(missing);
    expect(commanded.status).toBe(503);
    expect((await envelopeOf(commanded)).error?.message).toBe(missing);
    expect((await envelopeOf(released)).error?.message).toBe(missing);
    expect((await envelopeOf(made)).error?.message).toBe(missing);
    await expect.poll(async () => (await workerLeases(member)).length).toBe(1);
  });

  it("a heartbeat for a lease the front's memory lacks, whose release relay then fails with `RELAY_TARGET_MISSING`, answers the notAvailable reply with that message and leaves the simlock lease", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    const held = member.fake.leases.get(hex(1));
    expect(held).toBeDefined();
    member.fake.leases.set(hex(2), {
      ...(held as NonNullable<typeof held>),
      leaseId: hex(2),
      tenant: (held?.tenant ?? "").replace(hex(1), hex(2)),
    });
    // why: a lease whose requester is not its own id is never adopted, so the front's memory lacks it however soon the worker's catalog arrives.
    await rig.gateway.dispatch(
      "lease.request",
      { leaseId: hex(2), platform: "ios", requesterId: "someone-else", requires: ["agent-device"] },
      sessionFor(principals.one),
    );
    interceptRelay(rig, async ({ request }) => {
      const body = (await request.clone().json()) as { method?: string };
      if (body.method === "agent_device.lease.release") {
        throw new DispatchError(
          "RELAY_TARGET_MISSING",
          "no relay target agent-device on this worker",
        );
      }
    });

    const beat = await envelopeOf(await heartbeat(rig, 2));

    expect(beat.error?.message).toBe(`${notAvailable}no relay target agent-device on this worker`);
    expect((await fleetLeases(rig)).map((lease) => lease.id)).toContain(hex(2));
  });

  it("a lease the gateway's `lease.list` leaves out during devices, allocate, boot, renewal or heartbeat is not ended, and the next heartbeat renews it", async () => {
    const during: Record<string, unknown> = {};
    const triggers: Record<string, (rig: Rig, member: Member) => Promise<void>> = {
      allocate: async (rig) => {
        await grantedOnGateway(rig, 2);
      },
      devices: async (rig) => {
        await command(rig, "devices", undefined);
      },
      heartbeat: async (rig) => {
        const beat = await envelopeOf(await heartbeat(rig, 1));
        during.heartbeat = beat.result ?? beat.error?.data;
      },
      boot: async (rig) => {
        const answer = await envelopeOf(await command(rig, "boot", 1));
        during.boot = answer.error?.data;
      },
      renewal: async (rig, member) => {
        const running = await runningCommand(rig, member, 1);
        await advance(rig, 10_000, 5_000);
        member.fake.releaseCommand();
        await running.promise;
      },
    };
    const outcomes: Record<string, { cut: number; answer: unknown; leftMs: unknown }> = {};

    for (const [name, trigger] of Object.entries(triggers)) {
      const rig = await setUp({ workers: [{ label: "w1", maxRunning: 2 }] });
      const member = first(rig);
      await grantedOnGateway(rig, 1, { ttlMs: 30_000 });
      await listedByGateway(rig, 1);
      // why: the front's own record of the deadline is only the grant's, so an allocate re-reads lease 1 only once that has passed; a heartbeat keeps the simlock lease alive meanwhile.
      await advance(rig, 20_000, 5_000);
      expect((await envelopeOf(await heartbeat(rig, 1, { ttlMs: 30_000 }))).result).toMatchObject({
        ok: true,
      });
      await advance(rig, 15_000, 5_000);
      const listing = leaveOutOfNextListing(rig.gateway, hex(1));

      await trigger(rig, member);
      expect(listing.cut()).toBe(1);
      await advance(rig, 1_000, 1_000);
      const answer = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

      outcomes[name] = {
        answer: answer.result ?? answer.error?.data,
        cut: listing.cut(),
        leftMs: ((await deadlineOf(member, 1)) ?? Number.NaN) - rig.clock.now(),
      };
      await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
    }

    const live = { answer: expect.objectContaining({ ok: true }), cut: 1, leftMs: 60_000 };
    expect(outcomes).toEqual({
      allocate: live,
      boot: live,
      devices: live,
      heartbeat: live,
      renewal: live,
    });
    // why: the command already ran on the worker, so the heartbeat that met the omission still answers its reply.
    expect(during).toEqual({
      boot: expect.objectContaining({
        message: "could not check your leases; try again",
        retriable: true,
      }),
      heartbeat: expect.objectContaining({ ok: true }),
    });
  });
});
