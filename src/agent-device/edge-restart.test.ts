import { describe, expect, it } from "vitest";

import {
  heartbeat,
  setUpWithPhone,
  advance,
  listed,
  release,
  tapDispatch,
  track,
} from "./test-edge.js";
import {
  notAvailable,
  type Rig,
  type Envelope,
  sleep,
  setUp,
  envelopeOf,
  hex,
  granted,
  allocatesReceived,
  runCommand,
  leases,
  principals,
  scope,
  secrets,
  sessionFor,
  rpc,
} from "./test-support.js";

describe("the agent-device front, through the whole worker daemon: after agent-device restarts", () => {
  it.each([
    ["a simulator lease", "simulator", { platform: "android" }, {}],
    [
      "a phone lease, whose allocate reaches the phone daemon",
      "phone",
      { platform: "android", physical: true },
      {},
    ],
    [
      "an entry allocated with retainOnClose, whose re-allocate carries it",
      "simulator",
      { platform: "android", retainOnClose: true },
      {},
    ],
    [
      "a heartbeat carrying deviceKey, clientId and runId, whose re-allocate carries all three",
      "simulator",
      { platform: "android" },
      { deviceKey: "ios:mobile:00008110-001A2B3C4D5E" },
    ],
  ] as const)(
    "after agent-device restarts on a worker, an agent's next heartbeat succeeds and the simlock lease is kept on the same device: %s",
    async (_case, daemon, allocateExtra, heartbeatExtra) => {
      const rig: Rig = await setUpWithPhone();
      const fake = daemon === "phone" ? rig.phone : rig.fake;
      if ("deviceKey" in heartbeatExtra) fake.nameDeviceKeyInNextReply(heartbeatExtra.deviceKey);
      await granted(rig, 1, allocateExtra);
      const before = fake.leases.get(hex(1));
      expect(before).toBeDefined();
      fake.restart();
      expect(fake.leases.has(hex(1))).toBe(false);

      const answer = await envelopeOf(await heartbeat(rig, 1, heartbeatExtra));
      expect(answer.error).toBeUndefined();
      expect(answer.result).toMatchObject({ ok: true });
      const after = fake.leases.get(hex(1));
      expect(after?.address).toBe(before?.address);
      expect(after?.retainOnClose).toBe(before?.retainOnClose);
      expect(await listed(rig)).toEqual([hex(1)]);

      expect((await envelopeOf(await heartbeat(rig, 1, heartbeatExtra))).error).toBeUndefined();
      const opened = await envelopeOf(await runCommand(rig, "open", 1));
      expect(opened.error).toBeUndefined();
      expect(opened.result).toMatchObject({ ok: true });
      expect(fake.rpcRequests("agent_device.command").at(-1)?.tenant).toBe(
        fake.leases.get(hex(1))?.tenant,
      );
    },
  );

  it("while a re-allocate fails, the agent gets the retryable reply and the simlock lease stays listed, and a later heartbeat recovers", async () => {
    const restoring = "the lease is being restored after an agent-device restart; try again";
    const cases = [
      [
        "allocate answered `LEASE_ID_IN_USE`",
        async (rig: Rig) => {
          rig.fake.failNextAllocate({
            code: "INVALID_ARGS",
            details: { reason: "LEASE_ID_IN_USE" },
            message: "lease id in use",
          });
          return heartbeat(rig, 1);
        },
        `${notAvailable}${restoring}`,
      ],
      [
        "allocate unanswered for 10 s",
        async (rig: Rig) => {
          rig.fake.holdAllocate();
          const pending = track(heartbeat(rig, 1));
          await expect.poll(() => allocatesReceived(rig, 1)).toHaveLength(2);
          await advance(rig, 9_000);
          expect(pending.done()).toBe(false);
          await advance(rig, 1_000);
          await expect.poll(() => pending.done(), { timeout: 2_000 }).toBe(true);
          rig.fake.letAllocateGo();
          return pending.promise;
        },
        `${notAvailable}${restoring}`,
      ],
      [
        "allocate accepted with no release scope",
        async (rig: Rig) => {
          rig.fake.editNextAllocateReply({ runId: undefined });
          return heartbeat(rig, 1);
        },
        `${notAvailable}${restoring}`,
      ],
      [
        "agent-device still starting",
        async (rig: Rig) => {
          rig.fake.setUnavailable("starting", true);
          const response = await heartbeat(rig, 1);
          rig.fake.setUnavailable(undefined);
          return response;
        },
        `${notAvailable}starting`,
      ],
    ] as const;
    for (const [label, failing, message] of cases) {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      rig.fake.restart();
      const before = allocatesReceived(rig, 1).length;

      const answer = await envelopeOf(await failing(rig));

      expect(answer.error).toMatchObject({ data: { retriable: true }, message });
      if (label === "agent-device still starting") {
        expect(allocatesReceived(rig, 1)).toHaveLength(before);
      }
      expect(await listed(rig)).toEqual([hex(1)]);
      const recovered = await envelopeOf(await heartbeat(rig, 1));
      expect(recovered.error).toBeUndefined();
      expect(recovered.result).toMatchObject({ ok: true });
    }
  });

  it("two heartbeats at once after a restart send one re-allocate, and both succeed", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.restart();
    rig.fake.holdAllocate();

    const both = Promise.all([heartbeat(rig, 1), heartbeat(rig, 1)]);
    await expect.poll(() => allocatesReceived(rig, 1)).toHaveLength(2);
    await sleep(50);
    rig.fake.letAllocateGo();
    const answers = await Promise.all((await both).map((response) => envelopeOf(response)));

    expect(answers.map((answer) => answer.error)).toEqual([undefined, undefined]);
    expect(answers.map((answer) => answer.result)).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(allocatesReceived(rig, 1)).toHaveLength(2);
  });

  it("after a restart, a heartbeat on a lease whose release is running answers ended and sends no re-allocate, a restored lease is renewed, and a second heartbeat's other error is relayed", async () => {
    const deadline = async (rig: Rig) =>
      (await leases(rig)).find((lease) => lease.id === hex(1))?.ttlDeadline;
    const cases = [
      [
        "a release is running",
        async (rig: Rig) => {
          // why: the entry is marked releasing only while simlock's own release runs, after agent-device has already dropped the lease.
          const tap = tapDispatch(rig);
          let answer: Envelope | undefined;
          tap.beforeNext("lease.release", async () => {
            answer = await envelopeOf(await heartbeat(rig, 1));
          });
          await release(rig, 1);
          expect(answer?.error).toMatchObject({
            data: { details: { reason: "LEASE_ENDED_BY_HOST" } },
          });
          expect(allocatesReceived(rig, 1)).toHaveLength(1);
        },
      ],
      [
        "the lease is restored",
        async (rig: Rig) => {
          const before = await deadline(rig);
          rig.fake.restart();
          await advance(rig, 5_000);
          const answer = await envelopeOf(await heartbeat(rig, 1));
          expect(answer.result).toMatchObject({ ok: true });
          expect(await deadline(rig)).toBe((before as number) + 5_000);
        },
      ],
      [
        "the second heartbeat fails with another error",
        async (rig: Rig) => {
          const before = await deadline(rig);
          rig.fake.restart();
          await advance(rig, 5_000);
          rig.fake.failHeartbeatAfterNextAllocate({
            code: "COMMAND_FAILED",
            message: "daemon is busy",
          });
          const answer = await envelopeOf(await heartbeat(rig, 1));
          expect(answer.error).toMatchObject({
            data: { code: "COMMAND_FAILED" },
            message: "daemon is busy",
          });
          expect(await listed(rig)).toEqual([hex(1)]);
          expect(await deadline(rig)).toBe(before);
        },
      ],
    ] as const;
    for (const [, check] of cases) {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      await check(rig);
    }
  });

  it.each([
    ["a simulator lease", "simulator"],
    ["a phone lease, whose re-allocate reaches the phone daemon", "phone"],
  ] as const)(
    "after a standalone worker restarts, the agent's next heartbeat succeeds on the same device: %s",
    async (_case, daemon) => {
      const first = await setUpWithPhone();
      const fake = daemon === "phone" ? first.phone : first.fake;
      await granted(
        first,
        1,
        daemon === "phone" ? { physical: true, platform: "android" } : { platform: "android" },
      );
      const before = fake.leases.get(hex(1));
      const rig = await first.restart(() => {
        first.fake.restart();
        first.phone.restart();
      });
      expect(fake.leases.has(hex(1))).toBe(false);

      const answer = await envelopeOf(await heartbeat(rig, 1));

      expect(answer.error).toBeUndefined();
      expect(answer.result).toMatchObject({ ok: true });
      expect(fake.leases.get(hex(1))?.address).toBe(before?.address);
      expect(await listed(rig)).toEqual([hex(1)]);
      const opened = await envelopeOf(await runCommand(rig, "open", 1));
      expect(opened.result).toMatchObject({ ok: true });
    },
  );

  it("after a standalone worker restarts, a lease of another token and a lease whose requester id is not its id are not adopted, so their heartbeats answer as before the change", async () => {
    const first = await setUpWithPhone();
    await granted(first, 2, { platform: "android" }, { token: secrets.two });
    const outside = await first.daemon.dispatch(
      "lease.request",
      { platform: "android", requesterId: "made-outside-the-front" },
      sessionFor(principals.one),
    );
    const rig = await first.restart(() => {
      first.fake.restart();
      first.phone.restart();
    });

    const other = await envelopeOf(await heartbeat(rig, 2));
    expect(other.result).toBeUndefined();
    expect(other.error).toMatchObject({
      data: {
        code: "UNAUTHORIZED",
        details: { reason: "LEASE_ENDED_BY_HOST" },
        message: "lease ended by simlock; run disconnect, then open",
        retriable: false,
      },
    });
    const outsideAnswer = await envelopeOf(
      await rpc(rig, "agent_device.lease.heartbeat", { ...scope, leaseId: outside.lease.id }),
    );

    expect(outsideAnswer.error).toMatchObject({
      data: { code: "UNAUTHORIZED", details: { reason: "LEASE_NOT_FOUND" } },
    });
    expect(allocatesReceived(rig, 2)).toHaveLength(1);
    expect(
      rig.fake
        .rpcRequests("agent_device.lease.allocate")
        .filter((request) => request.params?.["leaseId"] === outside.lease.id),
    ).toEqual([]);
    expect(await listed(rig)).toEqual([hex(2), outside.lease.id].sort());
  });
});
