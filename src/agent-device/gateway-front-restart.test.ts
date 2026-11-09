import { describe, expect, it, vi } from "vitest";

import {
  commandsReceived,
  runningDaemons,
  Member,
  Rig,
  setUp,
  viewOf,
  untilRead,
  envelopeOf,
  hex,
  granted,
  heartbeat,
  command,
  fleetLeases,
  workerLeaseFor,
  grantedDevice,
  wipes,
  first,
  leaveOutOfNextListing,
  advance,
  restarted,
} from "./test-gateway.js";

async function restartedWorker(rig: Rig, original: Member): Promise<Member> {
  const stopped = await original.daemon;
  await stopped.stop("test");
  runningDaemons.splice(runningDaemons.indexOf(stopped), 1);
  await vi.waitFor(async () =>
    expect((await viewOf(rig, original.label))?.connection).toBe("disconnected"),
  );
  original.fake.restart();
  const member = await rig.addWorker(original.spec, original);
  await untilRead(rig, member);
  await expect
    .poll(async () => (await fleetLeases(rig)).map((lease) => lease.id))
    .toEqual([hex(1)]);
  return member;
}

describe("the agent-device front, through a gateway: after a restart", { timeout: 90_000 }, () => {
  it.each([
    ["a worker restart", async (rig: Rig, member: Member) => restartedWorker(rig, member)],
    [
      "a gateway restart, then a worker restart",
      async (rig: Rig, member: Member) => {
        await restarted(rig, member, 1);
        return restartedWorker(rig, member);
      },
    ],
    [
      "a worker restart, then a gateway restart",
      async (rig: Rig, member: Member) => {
        const next = await restartedWorker(rig, member);
        await restarted(rig, next, 1);
        return next;
      },
    ],
  ])(
    "through a gateway, %s leaves the lease working and the device unwiped, and an `open` relayed through the gateway reaches the worker's same fake daemon and answers ok",
    async (_case, restart) => {
      const rig = await setUp();
      const original = first(rig);
      await granted(rig, 1);
      const leased = await grantedDevice(original);
      const member = await restart(rig, original);
      expect(member.fake.leases.has(hex(1))).toBe(false);
      const wiped = wipes(member);

      const answer = await envelopeOf(await heartbeat(rig, 1));

      expect(answer.error).toBeUndefined();
      expect(answer.result).toMatchObject({ ok: true });
      expect(member.fake.leases.get(hex(1))?.address).toBe(leased.address);
      expect(await workerLeaseFor(member, 1)).toBeDefined();
      expect(wipes(member)).toBe(wiped);
      const commands = commandsReceived(member);
      const opened = await envelopeOf(await command(rig, "open", 1));
      expect(opened.error).toBeUndefined();
      expect(opened.result).toMatchObject({ ok: true });
      expect(commandsReceived(member)).toBe(commands + 1);
    },
  );
});

describe(
  "the agent-device front, through a gateway: a worker still starting",
  { timeout: 90_000 },
  () => {
    it.each([
      ["inside the first grant's TTL", 0],
      ["past the first grant's TTL, after two renewing heartbeats", 2],
    ])(
      "through a gateway, a worker still starting, whose list leaves the lease out while the index holds it, gets the retryable reply and keeps the lease, %s",
      async (_case, renewals) => {
        const rig = await setUp();
        await granted(rig, 1);
        for (let renewed = 0; renewed < renewals; renewed += 1) {
          await advance(rig, 100_000);
          expect((await envelopeOf(await heartbeat(rig, 1))).error).toBeUndefined();
        }
        const member = await restartedWorker(rig, first(rig));
        const listing = leaveOutOfNextListing(rig.gateway, hex(1));

        const answer = await envelopeOf(await heartbeat(rig, 1));

        expect(listing.cut()).toBe(1);
        expect(answer.error).toMatchObject({
          data: { retriable: true },
          message:
            "agent-device is not available on this simlock: the lease is being restored after an agent-device restart; try again",
        });
        expect((await fleetLeases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
        expect(member.fake.leases.has(hex(1))).toBe(false);
        expect((await envelopeOf(await heartbeat(rig, 1))).error).toBeUndefined();
      },
    );
  },
);
