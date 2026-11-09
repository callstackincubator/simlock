import { describe, expect, it } from "vitest";

import { heartbeat, setUpWithPhone, advance, listed, track } from "./test-edge.js";
import {
  notAvailable,
  type Rig,
  sleep,
  setUp,
  envelopeOf,
  hex,
  granted,
  allocatesReceived,
  runCommand,
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
          const response = await pending.promise;
          rig.fake.letAllocateGo();
          return response;
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
});
