import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import {
  heartbeat,
  advance,
  release,
  liveStates,
  track,
  listed,
  simlockPicks,
  batch,
} from "./test-edge.js";
import {
  secrets,
  scope,
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
  runCommand,
  forwarded,
  refused,
} from "./test-support.js";
import { phoneModels, expectLeaseGone } from "./test-edge-front.js";

describe("the agent-device front, through the whole worker daemon", () => {
  it("an agent-device allocate that answers an error, and a grant that names no device address, release the simlock lease, and the CLI gets the error", async () => {
    const rig: Rig = await setUp();
    rig.fake.failNextAllocate({
      code: "NO_DEVICE",
      message: "no such device",
      details: { reason: "AGENT_DEVICE_REASON" },
    });

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toEqual({
      code: -32000,
      data: {
        code: "NO_DEVICE",
        message: "no such device",
        details: { reason: "AGENT_DEVICE_REASON" },
      },
      message: "no such device",
    });
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    class NoAddressDriver extends FakeDriver {
      override async makeReady(...arguments_: Parameters<FakeDriver["makeReady"]>) {
        const ready = await super.makeReady(...arguments_);
        return { ...ready, address: undefined as unknown as string };
      }
    }
    const bare = await setUp({
      drivers: (clock) => [
        new NoAddressDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });

    const noAddress = await envelopeOf(await allocate(bare, 2));

    expect(noAddress.error?.data).toMatchObject({
      code: "COMMAND_FAILED",
      details: { reason: "SIMLOCK_FAILED" },
      retriable: false,
    });
    await expect.poll(async () => (await leases(bare)).length).toBe(0);
    expect(allocatesReceived(bare, 2)).toEqual([]);
  });

  it("an agent-device allocate to an unreachable daemon answers the proxy's `UNKNOWN` error and one with a non-JSON body answers `COMMAND_FAILED`, and each releases the simlock lease; when agent-device answers the follow-up release with a scope error, the simlock lease stays until its TTL, and when it answers `LEASE_NOT_FOUND`, the simlock lease is released", async () => {
    const rig: Rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await allocate(rig, 2));
    rig.fake.setUnreachable(false);

    expect(unreachable.error?.data).toMatchObject({ code: "UNKNOWN", message: "fetch failed" });
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    const notJson = await envelopeOf(await allocate(rig, 3));

    expect(notJson.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    rig.fake.failNextRelease({ code: "UNAUTHORIZED", message: "lease scope mismatch" });
    const kept = await envelopeOf(await allocate(rig, 4, { ttlMs: 60_000 }));

    expect(kept.error?.data?.code).toBe("COMMAND_FAILED");
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(4));
    await advance(rig, 61_000);
    await expect
      .poll(async () => (await leases(rig)).map((lease) => lease.id))
      .not.toContain(hex(4));

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    rig.fake.failNextRelease({ code: "LEASE_NOT_FOUND", message: "no such lease" });
    const gone = await envelopeOf(await allocate(rig, 5, { ttlMs: 60_000 }));

    expect(gone.error?.data?.code).toBe("COMMAND_FAILED");
    await expect
      .poll(async () => (await leases(rig)).map((lease) => lease.id))
      .not.toContain(hex(5));
  });

  it("the follow-up release after an allocate with no usable reply carries the allocate's runId, leaseProvider and clientId and not its deviceKey", async () => {
    const rig: Rig = await setUp();
    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");

    const answer = await envelopeOf(await allocate(rig, 1, { deviceKey: "saved-device" }));

    expect(answer.error?.data?.code).toBe("COMMAND_FAILED");
    const params = rig.fake.rpcRequests("agent_device.lease.release")[0]?.params;
    expect(params).toMatchObject({ ...scope, leaseId: hex(1) });
    expect(params).not.toHaveProperty("deviceKey");
  });

  it("a lease whose allocate reply names device key `ios:mobile:<id>` keeps it: a command naming that lease with that `deviceKey` reaches agent-device", async () => {
    const rig: Rig = await setUp();
    const key = "ios:mobile:00008110-001A2B3C4D5E";
    rig.fake.nameDeviceKeyInNextReply(key);
    await granted(rig, 1);

    await forwarded(rig, () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: key } }));
  });

  it("an allocate reply whose lease `deviceKey` is over 128 characters still succeeds and keeps the lease, with the device key left unset: no release is sent and a command naming the lease with a `deviceKey` is refused", async () => {
    const rig: Rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("x".repeat(129));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toBeUndefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(0);
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(1));
    await refused(
      rig,
      () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "x".repeat(129) } }),
      simlockPicks,
    );
  });

  it("a CLI that hangs up while agent-device makes its lease leaves neither lease: the agent-device lease is released with the reply's scope, then the simlock lease; when that release fails, the simlock lease stays until its TTL", async () => {
    const rig: Rig = await setUp();
    rig.fake.holdAllocate();
    rig.fake.nameDeviceKeyInNextReply("device-key-1");
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 1).length).toBe(1);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();

    await expect.poll(async () => (await leases(rig)).length).toBe(0);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject({
      ...scope,
      deviceKey: "device-key-1",
    });

    rig.fake.holdAllocate();
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
    const abort = new AbortController();
    const second = track(allocate(rig, 2, { ttlMs: 60_000 }, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 2).length).toBe(1);
    abort.abort();
    await second.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();
    await expect.poll(() => rig.fake.rpcRequests("agent_device.lease.release").length).toBe(2);

    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
    await advance(rig, 61_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);
  });

  it("release goes to the agent-device daemon first, then frees the simlock lease and the device; a release after `close`, which already freed the simlock lease, reaches the daemon with no lease held and is answered `released: false`", async () => {
    const rig = await setUp();
    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = (await leases(rig)).map((lease) => lease.id);
    };
    await granted(rig, 1);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(heldAtDaemonRelease).toEqual([hex(1)]);
    expect(await leases(rig)).toEqual([]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);

    await granted(rig, 2);
    await command(rig, "close", 2);
    await expect.poll(async () => leases(rig)).toEqual([]);
    const afterClose = await envelopeOf(await release(rig, 2));

    expect(afterClose.result).toMatchObject({ ok: true, released: false });
    expect(heldAtDaemonRelease).toEqual([]);
    expect(await leases(rig)).toEqual([]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
  });

  it("a runner allocates with retainOnClose, closes, and its lease stays until release", async () => {
    const cases = [
      (rig: Rig) => command(rig, "close", 1),
      (rig: Rig) => command(rig, "close", 1, {}, { positionals: ["com.example.app"] }),
      (rig: Rig) => batch(rig, 1, [{ command: "snapshot" }, { command: "close" }]),
    ];
    for (const close of cases) {
      const rig: Rig = await setUp();
      expect(
        (await envelopeOf(await allocate(rig, 1, { retainOnClose: true }))).result,
      ).toMatchObject({ ok: true, data: { lease: { retainOnClose: true } } });
      expect((await envelopeOf(await close(rig))).result).toMatchObject({ ok: true });
      expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
      expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
      expect((await envelopeOf(await command(rig, "snapshot", 1))).result).toMatchObject({
        ok: true,
      });
      expect((await envelopeOf(await release(rig, 1))).result).toMatchObject({
        ok: true,
        released: true,
      });
      expect(await leases(rig)).toEqual([]);
      await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
    }
  });

  const ended = [{ leaseId: hex(1), outcome: "released" }];
  it.each([
    [
      "a `close` that succeeds, in `data`",
      { result: { data: { endedLeases: ended } } },
      (rig: Rig) => command(rig, "close", 1),
    ],
    [
      "a `close` that fails, in `error.details`",
      { error: { data: { details: { endedLeases: ended } } } },
      (rig: Rig) => {
        rig.fake.failNextCommand({ code: "COMMAND_FAILED", message: "close failed" });
        return command(rig, "close", 1);
      },
    ],
    [
      "a `batch` with a close step, in `data` beside `results`",
      { result: { data: { endedLeases: ended, results: [] } } },
      (rig: Rig) => batch(rig, 1, [{ command: "snapshot" }, { command: "close" }]),
    ],
  ] as const)(
    "%s: a command that ends the agent-device lease and names it in `endedLeases` releases the simlock lease and frees the device though the CLI sends no release, and a later heartbeat answers `LEASE_NOT_FOUND`",
    async (_case, reply, send) => {
      const rig = await setUp();
      await granted(rig, 1);

      expect(await envelopeOf(await send(rig))).toMatchObject(reply);
      await expect.poll(async () => listed(rig)).toEqual([]);
      await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
      expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
    },
  );

  // why: agent-device 0.21.28 streams a reply when the CLI runs without --json; the JSON-RPC answer is the `response` of a `type: "response"` line, not the line itself.
  it("a close streamed in agent-device's own line shape releases the simlock lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const chunks = [
      `${JSON.stringify({ event: { kind: "command", message: "Closing" }, type: "progress" })}\n`,
      `${JSON.stringify({
        response: {
          id: "x",
          jsonrpc: "2.0",
          result: { data: { endedLeases: ended, session: "t:adc-1" }, ok: true },
        },
        type: "response",
      })}\n`,
    ];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(rig, "close", 1);

    expect(await streamed.text()).toBe(chunks.join(""));
    await expect.poll(async () => listed(rig), { timeout: 3_000 }).toEqual([]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
  });

  it("a release the agent-device daemon fails keeps the simlock lease and answers the daemon's error", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon could not release" });

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon could not release",
    });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("a release from a second token naming the first token's lease ID leaves the first token's simlock lease in place", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.error).toBeDefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(1);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    rig.fake.letAnyTenantRelease();
    const crossed = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(crossed.result).toMatchObject({ ok: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });
});
