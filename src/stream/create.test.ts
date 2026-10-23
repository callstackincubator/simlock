import { describe, expect, it } from "vitest";

import { type ScreenAvailability, ScreenNotSupportedError } from "../core/index.js";
import { FakeClock, NoopLogger } from "../ports/index.js";
import { createWorkerStream } from "./create.js";
import { ScriptedFeed, TestRegistry } from "./test-fixtures.js";

function worker(
  availability: readonly ScreenAvailability[] = [],
  sendsMeta = true,
  unsupported = false,
) {
  const clock = new FakeClock();
  const registry = new TestRegistry(
    [{ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent", requesterId: "gw:inst:agent-1" }],
    [
      { id: "dev_1", platform: "ios" },
      { id: "dev_ready", platform: "ios", state: "ready" },
      { id: "dev_leased", platform: "ios", state: "leased" },
      { id: "dev_shutdown", platform: "ios", state: "shutdown" },
      { id: "dev_provisioning", platform: "ios", state: "provisioning" },
      { id: "dev_reclaiming", platform: "ios", state: "reclaiming" },
      { id: "dev_quarantined", platform: "ios", state: "quarantined" },
      { id: "dev_absent", physical: true, platform: "ios", state: "absent" },
    ],
  );
  const feeds: ScriptedFeed[] = [];
  let opened = 0;
  const stream = createWorkerStream({
    clock,
    instanceId: "w1",
    logger: new NoopLogger(),
    name: "stream",
    registry,
    screens: {
      openScreen: async () => {
        opened += 1;
        if (unsupported) throw new ScreenNotSupportedError("no capture here");
        const feed = new ScriptedFeed();
        if (sendsMeta) feed.meta();
        feeds.push(feed);
        return feed;
      },
      screenAvailability: async () => availability,
    },
    settings: { bitrateKbps: 1500, fps: 30, maxDimension: 720 },
  });
  return { clock, feeds, opened: () => opened, stream };
}

const OPERATOR = { principal: "tok_op", role: "operator" };

const deviceRequest = (worker: string, device: string) =>
  new Request(`http://daemon/v1/stream/workers/${worker}/devices/${device}`);

const relayed = () => new Request("http://simlock-worker/stream/leases/lse_1");

async function settledWithin<T>(promise: Promise<T>): Promise<T | "pending"> {
  for (let flush = 0; flush < 10; flush += 1) await new Promise((resolve) => setImmediate(resolve));
  return await Promise.race([promise, Promise.resolve("pending" as const)]);
}

describe("createWorkerStream", () => {
  it("reports the stream available, with no reason, when any platform can capture", async () => {
    for (const availability of [
      [{ platform: "android" }, { platform: "ios", reason: "No capture program at /x" }],
      [{ platform: "ios", reason: "No capture program at /x" }, { platform: "android" }],
    ] as const) {
      const { stream } = worker(availability);
      expect(stream.capabilitySource.name).toBe("stream");
      expect(await stream.capabilitySource.read()).toEqual({ state: "available" });
    }
  });

  it("gives a capture 30 s to send its first frame", async () => {
    const { clock, feeds, stream } = worker([], false);
    const served = stream.relayTarget(relayed(), "gw:inst:agent-1", "lse_1");
    await settledWithin(served);
    clock.advance(29_999);
    expect(await settledWithin(served)).toBe("pending");
    clock.advance(1);
    const answer = await settledWithin(served);
    expect(answer === "pending" ? answer : answer.status).toBe(503);
    expect(feeds[0]?.closes).toBe(1);
  });

  it("ends a stream whose capture sends nothing for 30 s", async () => {
    const { clock, feeds, stream } = worker();
    const served = await stream.relayTarget(relayed(), "gw:inst:agent-1", "lse_1");
    const reader = served.body!.getReader();
    await reader.read();
    const next = reader.read().then(
      () => "read",
      () => "failed",
    );
    clock.advance(29_999);
    expect(await settledWithin(next)).toBe("pending");
    clock.advance(1);
    expect(await settledWithin(next)).toBe("failed");
    expect(feeds[0]?.closes).toBe(1);
  });

  it("reports the stream unavailable with each platform's reason when none can capture", async () => {
    const { stream } = worker([
      { platform: "android", reason: "no jar" },
      { platform: "ios", reason: "No capture program at /x" },
    ]);
    expect(await stream.capabilitySource.read()).toEqual({
      reason: "android: no jar; ios: No capture program at /x",
      state: "unavailable",
    });
  });

  it("reports the stream unavailable when no driver on the host can capture", async () => {
    const { stream } = worker([]);
    expect(await stream.capabilitySource.read()).toEqual({
      reason: "No driver on this host can capture a screen",
      state: "unavailable",
    });
  });

  it("serves a relayed request for the requester the gateway names, checked against this worker's registry", async () => {
    const { stream } = worker();
    const request = () => new Request("http://simlock-worker/stream/leases/lse_1");
    const served = await stream.relayTarget(request(), "gw:inst:agent-1", "lse_1");
    expect(served.status).toBe(200);
    await served.body?.cancel();
    const refused = await stream.relayTarget(request(), "gw:inst:agent-2", "lse_1");
    expect(refused.status).toBe(404);
  });

  it("stops a relayed capture when its lease ends", async () => {
    const { feeds, stream } = worker();
    const served = await stream.relayTarget(
      new Request("http://simlock-worker/stream/leases/lse_1"),
      "gw:inst:agent-1",
      "lse_1",
    );
    expect(served.status).toBe(200);
    await stream.leaseEnd.leaseEnded(
      { leaseId: "lse_1" } as Parameters<typeof stream.leaseEnd.leaseEnded>[0],
      new AbortController().signal,
    );
    expect(feeds[0]?.closes).toBe(1);
  });

  it("serves an operator the stream of a ready or leased device, and refuses any other device with its reason before opening anything", async () => {
    for (const device of ["dev_ready", "dev_leased"]) {
      const { opened, stream } = worker();
      const served = await stream.mount.handle(deviceRequest("w1", device), OPERATOR);
      expect(served.status, device).toBe(200);
      expect(opened(), device).toBe(1);
      await served.body?.cancel();
    }
    const refusals: [string, string, number, string, string][] = [
      [
        "w1",
        "dev_shutdown",
        409,
        "DEVICE_NOT_RUNNING",
        "The device is shutdown; only a ready or leased device streams",
      ],
      [
        "w1",
        "dev_provisioning",
        409,
        "DEVICE_NOT_RUNNING",
        "The device is provisioning; only a ready or leased device streams",
      ],
      [
        "w1",
        "dev_reclaiming",
        409,
        "DEVICE_NOT_RUNNING",
        "The device is reclaiming; only a ready or leased device streams",
      ],
      [
        "w1",
        "dev_quarantined",
        409,
        "DEVICE_NOT_RUNNING",
        "The device is quarantined; only a ready or leased device streams",
      ],
      [
        "w1",
        "dev_absent",
        409,
        "DEVICE_NOT_RUNNING",
        "The device is absent; only a ready or leased device streams",
      ],
      ["w1", "dev_nope", 404, "UNKNOWN_DEVICE", "Unknown device: dev_nope"],
      ["w2", "dev_ready", 404, "UNKNOWN_WORKER", "Unknown worker: w2"],
    ];
    for (const [workerId, device, status, code, message] of refusals) {
      const { opened, stream } = worker();
      const refused = await stream.mount.handle(deviceRequest(workerId, device), OPERATOR);
      expect(refused.status, device).toBe(status);
      expect(await refused.json(), device).toEqual({ error: { code, message } });
      expect(opened(), device).toBe(0);
    }
    const { stream } = worker([], true, true);
    const unsupported = await stream.mount.handle(deviceRequest("w1", "dev_ready"), OPERATOR);
    expect(unsupported.status).toBe(415);
    expect(((await unsupported.json()) as { error: { code: string } }).error.code).toBe(
      "STREAM_NOT_SUPPORTED",
    );
  });
});
