import { describe, expect, it, vi } from "vitest";
import {
  commandsReceived,
  secrets,
  principals,
  notAvailable,
  slowCatalogMs,
  adminSession,
  sessionFor,
  Envelope,
  Member,
  Rig,
  sleep,
  setUp,
  viewOf,
  untilRead,
  advance,
  send,
  envelopeOf,
  hex,
  allocate,
  grantedOnGateway,
  release,
  heartbeat,
  command,
  fleetLeases,
  deadlineOf,
  track,
  expectEndedBySimlock,
  tapDispatch,
  heartbeatsReceived,
  allocatesReceived,
  runningCommand,
  first,
  restarted,
} from "./test-gateway.js";
import {
  notYoursOnGateway,
  leased,
  holderOf,
  listedByGateway,
  twoLeasesOnTwoWorkers,
  addressOfLease,
  pathsReceived,
  listedNames,
  picksTheDevice,
} from "./test-gateway-front.js";

const unreachableReason =
  "the worker holding this device is not connected to the gateway; try again";

const unreachableMessage = `${notAvailable}${unreachableReason}`;

const gatewayWindowMs = 60_000;

const hourMs = 3_600_000;

function expectUnreachable(answer: Envelope): void {
  expect(answer.result).toBeUndefined();
  expect(answer.error).toMatchObject({
    data: {
      details: { reason: "WORKER_UNREACHABLE" },
      message: unreachableMessage,
      retriable: true,
    },
    message: unreachableMessage,
  });
}

async function expectUnreachablePlain(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body["error"]).toBe(unreachableMessage);
  expect(body).toMatchObject({ reason: "WORKER_UNREACHABLE", retriable: true });
}

async function expectUnreachableEverywhere(rig: Rig, n: number): Promise<void> {
  for (const response of [
    await heartbeat(rig, n),
    await command(rig, "snapshot", n),
    await release(rig, n),
  ]) {
    expect(response.status).toBe(503);
    expectUnreachable(await envelopeOf(response));
  }
  await expectUnreachablePlain(
    await send(rig, "/upload/preflight", { body: "{}", headers: leased(n) }),
  );
}

// why: the gateway closes the worker's socket as a network drop does; the worker redials only when its clock moves.
async function dropUplink(rig: Rig, member: Member): Promise<void> {
  const view = await viewOf(rig, member.label);
  expect(view?.id).toBeDefined();
  await rig.uplinks.closeWorkerLink(view?.id as string);
  await vi.waitFor(
    async () => expect((await viewOf(rig, member.label))?.connection).toBe("disconnected"),
    { timeout: 10_000 },
  );
}

async function untilConnected(rig: Rig, member: Member): Promise<void> {
  await advance(rig, 2_000, 500);
  await untilRead(rig, member);
}

async function commandWorks(rig: Rig, member: Member, n: number): Promise<void> {
  const before = commandsReceived(member);
  const answer = await envelopeOf(await command(rig, "snapshot", n));
  expect(answer.error).toBeUndefined();
  expect(answer.result).toBeDefined();
  expect(commandsReceived(member)).toBe(before + 1);
}

describe(
  "the agent-device front, through a gateway: an unreachable worker",
  {
    timeout: 90_000,
  },
  () => {
    it("with the device's worker disconnected, a command, a heartbeat and a release each answer 503 with `details.reason` `WORKER_UNREACHABLE` and the `workerUnreachable` message, and no agent-device daemon receives them", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);
      const received = member.fake.requests.length;

      for (const response of [
        await command(rig, "snapshot", 1),
        await heartbeat(rig, 1),
        await release(rig, 1),
      ]) {
        expect(response.status).toBe(503);
        expectUnreachable(await envelopeOf(response));
      }

      expect(member.fake.requests.length).toBe(received);
    });

    it("with the device's worker disconnected, an upload with the lease header answers 503 with that message, reason and retry flag, and `devices` answers the RPC reply", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);

      await expectUnreachablePlain(
        await send(rig, "/upload/preflight", { body: "{}", headers: leased(1) }),
      );
      const devices = await command(rig, "devices", undefined);

      expect(devices.status).toBe(503);
      expectUnreachable(await envelopeOf(devices));
    });

    it("with one of the token's two workers reconnected but not yet read and the other connected, `devices` answers `workerUnreachable()` and asks neither worker", async () => {
      const rig = await twoLeasesOnTwoWorkers();
      const gone = holderOf(rig, 1);
      const kept = holderOf(rig, 2);
      await listedByGateway(rig, 2);
      await dropUplink(rig, gone);
      gone.latency["listCatalog"] = slowCatalogMs;
      await advance(rig, 2_000, 500);
      await vi.waitFor(
        async () => {
          const view = await viewOf(rig, gone.label);
          expect(view?.connection).toBe("connected");
          expect(view?.catalogReadAt).toBeUndefined();
        },
        { timeout: 10_000 },
      );
      const received = [gone, kept].map((member) => member.fake.requests.length);

      const devices = await command(rig, "devices", undefined);

      expect(devices.status).toBe(503);
      expectUnreachable(await envelopeOf(devices));
      expect([gone, kept].map((member) => member.fake.requests.length)).toEqual(received);
    });

    it("while the worker is disconnected, the simlock lease is not released, and the front's entry is not marked ended", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      const tap = tapDispatch(rig.gateway);
      await dropUplink(rig, member);

      expectUnreachable(await envelopeOf(await heartbeat(rig, 1)));
      expectUnreachable(await envelopeOf(await release(rig, 1)));

      expect(tap.operations).not.toContain("lease.release");
      expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
      await untilConnected(rig, member);
      const beat = await envelopeOf(await heartbeat(rig, 1));
      expect(beat.error).toBeUndefined();
      expect(beat.result).toMatchObject({ ok: true });
    });

    it("a command answered WORKER_UNREACHABLE after an uplink drop stops renewing its lease after reconnect without releasing it", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1, { ttlMs: 30_000 });
      await listedByGateway(rig, 1);
      member.fake.keepCommandsAfterAbort();
      const running = await runningCommand(rig, member, 1);
      const before = await deadlineOf(member, 1);
      expect(before).toBeTypeOf("number");
      const tap = tapDispatch(rig.gateway);

      try {
        await dropUplink(rig, member);

        await vi.waitFor(() => expect(running.done()).toBe(true), { timeout: 5_000 });
        const answer = await running.promise;
        expect(answer.status).toBe(503);
        expectUnreachable(await envelopeOf(answer));
        await untilConnected(rig, member);
        await advance(rig, 20_000, 1_000);

        expect(tap.operations).not.toContain("lease.release");
        expect(await deadlineOf(member, 1)).toBe(before);
      } finally {
        member.fake.releaseCommand();
      }
    });

    it("right after the worker reconnects and before its view is refreshed, a command answers `workerUnreachable()`; once it is refreshed, within the TTL, the next command reaches it, and the next heartbeat renews the lease", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1, { ttlMs: 60_000 });
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);
      member.latency["listCatalog"] = slowCatalogMs;
      await advance(rig, 2_000, 500);
      await vi.waitFor(
        async () => {
          const view = await viewOf(rig, member.label);
          expect(view?.connection).toBe("connected");
          expect(view?.catalogReadAt).toBeUndefined();
        },
        { timeout: 10_000 },
      );

      expectUnreachable(await envelopeOf(await command(rig, "snapshot", 1)));

      await advance(rig, 9_000, 1_000);
      await untilRead(rig, member);
      await commandWorks(rig, member, 1);
      const beat = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));
      expect(beat.result).toMatchObject({ ok: true });
      expect(await deadlineOf(member, 1)).toBe(rig.clock.now() + 120_000);
    });

    it("a worker that stays disconnected past the TTL: once it reconnects, the next heartbeat answers `LEASE_ENDED_BY_HOST`", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      await dropUplink(rig, member);

      // why: one jump fires the worker's redial and the lease's expiry together, before the new socket is up.
      await sleep(50);
      rig.clock.advance(130_000);
      await untilConnected(rig, member);

      expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    });

    it("a lease known only from the link's memory (after `simlock release --all`) whose worker then disconnects answers `workerUnreachable()`", async () => {
      // why: a worker clock of its own, so moving the gateway's clock past the start window does not make the worker redial.
      const rig = await setUp({ workers: [{ clockSkewMs: 0, label: "w1" }] });
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await rig.gateway.dispatch("lease.release-all", {}, adminSession);
      await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
      await dropUplink(rig, member);
      // why: past the 60 s start window an unplaced lease is not unreachable, so only the link's memory can place this one.
      rig.clock.advance(70_000);

      expectUnreachable(await envelopeOf(await heartbeat(rig, 1)));
    });

    it("an unreachable command's final renewal fails while disconnected; after reconnect only a new heartbeat renews the retained lease", async () => {
      // why: a worker clock of its own, so moving the gateway's clock does not make the worker redial.
      const rig = await setUp({ workers: [{ clockSkewMs: 0, label: "w1" }] });
      const member = first(rig);
      await grantedOnGateway(rig, 1, { ttlMs: 30_000 });
      await listedByGateway(rig, 1);
      const running = await runningCommand(rig, member, 1);
      const tap = tapDispatch(rig.gateway);
      const before = await deadlineOf(member, 1);
      rig.clock.advance(1_000);
      await dropUplink(rig, member);
      expectUnreachable(await envelopeOf(await running.promise));

      rig.clock.advance(10_000);
      await sleep(50);

      expect(tap.operations).toContain("lease.renew");
      expect(tap.operations).not.toContain("lease.release");
      expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
      await untilConnected(rig, member);
      await advance(rig, 10_000, 5_000);
      await sleep(50);
      expect(before).toBe(31_000);
      expect(await deadlineOf(member, 1)).toBe(before);
      expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
      expect(await deadlineOf(member, 1)).toBe(member.clock.now() + 30_000);
      member.fake.releaseCommand();
    });

    it("an allocate by the same token while its other lease's worker is disconnected does not mark that lease ended", async () => {
      const rig = await setUp({
        workers: [
          { label: "w1", maxRunning: 1 },
          { label: "w2", maxRunning: 1 },
        ],
      });
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      const holder = holderOf(rig, 1);
      await dropUplink(rig, holder);

      await grantedOnGateway(rig, 2);
      expect((await fleetLeases(rig)).map((lease) => lease.id)).toContain(hex(1));
      await untilConnected(rig, holder);

      const beat = await envelopeOf(await heartbeat(rig, 1));
      expect(beat.error).toBeUndefined();
      expect(beat.result).toMatchObject({ ok: true });
    });
  },
);

describe(
  "the agent-device front, through a gateway: after a gateway restart",
  {
    timeout: 90_000,
  },
  () => {
    it("after a gateway restart and the worker's reconnect, the next heartbeat for the lease reaches the worker's agent-device daemon and renews the simlock lease, and a following command works", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1, { ttlMs: 60_000 });
      await listedByGateway(rig, 1);
      await restarted(rig, member, 1);
      const received = heartbeatsReceived(member);

      const beat = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

      expect(beat.result).toMatchObject({ ok: true });
      expect(heartbeatsReceived(member)).toBe(received + 1);
      expect(await deadlineOf(member, 1)).toBe(rig.clock.now() + 120_000);
      await commandWorks(rig, member, 1);
    });

    it("after a gateway restart, a command, a release, `devices` and an upload with the lease header, each as the token's first request, work on the adopted lease", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);

      await restarted(rig, member, 1);
      await commandWorks(rig, member, 1);

      await restarted(rig, member, 1);
      member.fake.listDevices([{ id: addressOfLease(rig, 1), name: "adopted" }]);
      expect(await listedNames(await command(rig, "devices", undefined))).toEqual(["adopted"]);

      await restarted(rig, member, 1);
      const preflight = await send(rig, "/upload/preflight", { body: "{}", headers: leased(1) });
      expect(preflight.status).toBe(200);
      expect(pathsReceived(member)).toContain("/upload/preflight");

      await restarted(rig, member, 1);
      const released = await envelopeOf(await release(rig, 1));
      expect(released.result).toMatchObject({ ok: true, released: true });
      expect(await fleetLeases(rig)).toEqual([]);
    });

    it("after a gateway restart, an adopted lease on a TV model reads target `tv`, and `test --target tv` sharding uses it", async () => {
      const rig = await setUp({ workers: [{ label: "w1", modelClass: "tv" }] });
      const member = first(rig);
      await grantedOnGateway(rig, 1, { target: "tv" });
      await listedByGateway(rig, 1);
      await restarted(rig, member, 1);

      const answer = await envelopeOf(
        await command(rig, "test", 1, {}, { flags: { shardAll: 1, target: "tv" } }),
      );

      expect(answer.error).toBeUndefined();
      const sent = member.fake.rpcRequests("agent_device.command").at(-1)?.params;
      const flags = (sent?.["flags"] ?? {}) as Record<string, unknown>;
      expect(flags["device"]).toBe(`simlock-${addressOfLease(rig, 1)}`);
    });

    it("after a gateway restart, a command naming a `deviceKey` on the adopted lease is accepted and sets it; a later command naming another `deviceKey` is refused `refused: simlock picks the device`", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      await restarted(rig, member, 1);

      const accepted = await envelopeOf(
        await command(rig, "snapshot", 1, {}, { meta: { deviceKey: "key-a" } }),
      );
      expect(accepted.error).toBeUndefined();
      const received = commandsReceived(member);
      const other = await envelopeOf(
        await command(rig, "snapshot", 1, {}, { meta: { deviceKey: "key-b" } }),
      );

      expect(other.error?.message).toBe(picksTheDevice);
      expect(commandsReceived(member)).toBe(received);
      const same = await envelopeOf(
        await command(rig, "snapshot", 1, {}, { meta: { deviceKey: "key-a" } }),
      );
      expect(same.error).toBeUndefined();
    });

    it("within 60 s of a gateway restart, before the worker reconnects, a heartbeat, a command, a release and an upload with the lease header for the lease each answer `workerUnreachable()`; after 60 s, with another capable worker connected, a heartbeat for it answers `refused: lease <id> is not one of yours on this gateway`", async () => {
      // why: a worker clock of its own, so the worker does not redial until the test moves it.
      const rig = await setUp({ workers: [{ clockSkewMs: 0, label: "w1" }] });
      const member = first(rig);
      await grantedOnGateway(rig, 1);
      await listedByGateway(rig, 1);
      await rig.restart();
      const received = member.fake.requests.length;

      await expectUnreachableEverywhere(rig, 1);
      rig.clock.advance(gatewayWindowMs - 1_000);
      await expectUnreachableEverywhere(rig, 1);

      expect(member.fake.requests.length).toBe(received);
      const other = await rig.addWorker({ label: "w2" });
      await other.daemon;
      await untilRead(rig, other);
      rig.clock.advance(2_000);
      const beat = await envelopeOf(await heartbeat(rig, 1));
      expect(beat.error?.message).toBe(notYoursOnGateway(1));
    });

    it("after a gateway restart, a lease of another token is not adopted, and a heartbeat naming it is refused", async () => {
      const rig = await setUp();
      const member = first(rig);
      await grantedOnGateway(rig, 1, {}, { token: secrets.two });
      await expect.poll(async () => (await fleetLeases(rig, principals.two)).length).toBe(1);
      await rig.restart();
      await untilConnected(rig, member);
      await expect.poll(async () => (await fleetLeases(rig, principals.two)).length).toBe(1);
      const received = commandsReceived(member);

      const beat = await envelopeOf(await heartbeat(rig, 1));
      const devices = await envelopeOf(await command(rig, "devices", undefined));

      expect(beat.error?.message).toBe(notYoursOnGateway(1));
      expect(devices.result).toMatchObject({ data: { devices: [] }, ok: true });
      expect(commandsReceived(member)).toBe(received);
    });

    it("after a gateway restart, a lease of this token whose requester is not its own id is not adopted", async () => {
      const rig = await setUp();
      const member = first(rig);
      await rig.gateway.dispatch(
        "lease.request",
        { platform: "ios", requesterId: "someone-else", requires: ["agent-device"] },
        sessionFor(principals.one),
      );
      await restarted(rig, member, 1);
      const received = commandsReceived(member);

      const devices = await envelopeOf(await command(rig, "devices", undefined));

      expect(devices.result).toMatchObject({ data: { devices: [] }, ok: true });
      expect(commandsReceived(member)).toBe(received);
    });

    it("a lease this gateway process asked for whose allocate failed after the grant (the uplink dropped mid-allocate) is never adopted, and stays out of `devices`, also when the worker's clock is an hour behind or ahead of the gateway's", async () => {
      for (const skew of [0, -hourMs, hourMs]) {
        const rig = await setUp({ workers: [{ clockSkewMs: skew, label: "w1" }] });
        const member = first(rig);
        member.fake.holdAllocate();
        const running = track(allocate(rig, 1));
        await expect.poll(() => allocatesReceived(member, 1).length).toBe(1);
        await dropUplink(rig, member);
        member.fake.letAllocateGo();
        await running.promise;
        await untilConnected(rig, member);
        const received = commandsReceived(member);

        const devices = await envelopeOf(await command(rig, "devices", undefined));

        expect(devices.result, `skew ${String(skew)}`).toMatchObject({
          data: { devices: [] },
          ok: true,
        });
        expect(commandsReceived(member)).toBe(received);
      }
    });

    it("after a gateway restart, a lease made before it is adopted when the worker's clock is an hour behind or ahead of the gateway's", async () => {
      for (const skew of [-hourMs, hourMs]) {
        const rig = await setUp({ workers: [{ clockSkewMs: skew, label: "w1" }] });
        const member = first(rig);
        await grantedOnGateway(rig, 1);
        await listedByGateway(rig, 1);
        await restarted(rig, member, 1);

        const beat = await envelopeOf(await heartbeat(rig, 1));

        expect(beat.error, `skew ${String(skew)}`).toBeUndefined();
        expect(beat.result).toMatchObject({ ok: true });
        await commandWorks(rig, member, 1);
      }
    });
  },
);
