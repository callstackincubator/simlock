import { describe, expect, it } from "vitest";

import type { ScreenAvailability } from "../core/index.js";
import { FakeClock, NoopLogger } from "../ports/index.js";
import { createWorkerStream } from "./create.js";
import { ScriptedFeed, TestRegistry } from "./test-fixtures.js";

function worker(availability: readonly ScreenAvailability[] = []) {
  const registry = new TestRegistry(
    [{ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent", requesterId: "gw:inst:agent-1" }],
    [{ id: "dev_1", platform: "ios" }],
  );
  const feeds: ScriptedFeed[] = [];
  const stream = createWorkerStream({
    clock: new FakeClock(),
    logger: new NoopLogger(),
    registry,
    screens: {
      openScreen: async () => {
        const feed = new ScriptedFeed();
        feed.meta();
        feeds.push(feed);
        return feed;
      },
      screenAvailability: async () => availability,
    },
    settings: { bitrateKbps: 1500, fps: 30, maxDimension: 720 },
  });
  return { feeds, stream };
}

describe("createWorkerStream", () => {
  it("reports the stream available, with no reason, when any platform can capture", async () => {
    const { stream } = worker([
      { platform: "android" },
      { platform: "ios", reason: "No capture program at /x" },
    ]);
    expect(stream.capabilitySource.name).toBe("stream");
    expect(await stream.capabilitySource.read()).toEqual({ state: "available" });
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
