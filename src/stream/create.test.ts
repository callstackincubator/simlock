import { describe, expect, it } from "vitest";

import type { ScreenAvailability } from "../core/index.js";
import { FakeClock, NoopLogger } from "../ports/index.js";
import { createWorkerStream } from "./create.js";
import { ScriptedFeed, TestRegistry } from "./test-fixtures.js";

function worker(availability: readonly ScreenAvailability[] = [], sendsMeta = true) {
  const clock = new FakeClock();
  const registry = new TestRegistry(
    [{ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent", requesterId: "gw:inst:agent-1" }],
    [{ id: "dev_1", platform: "ios" }],
  );
  const feeds: ScriptedFeed[] = [];
  const stream = createWorkerStream({
    clock,
    logger: new NoopLogger(),
    name: "stream",
    registry,
    screens: {
      openScreen: async () => {
        const feed = new ScriptedFeed();
        if (sendsMeta) feed.meta();
        feeds.push(feed);
        return feed;
      },
      screenAvailability: async () => availability,
    },
    settings: { bitrateKbps: 1500, fps: 30, maxDimension: 720 },
  });
  return { clock, feeds, stream };
}

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
});
