import { describe, expect, it } from "vitest";

import {
  type ScreenAvailability,
  SCREEN_FRAME_TAG,
  ScreenNotSupportedError,
} from "../core/index.js";
import { FakeClock, NoopLogger } from "../ports/index.js";
import { createGatewayStream, createWorkerStream } from "./create.js";
import { ScriptedFeed, TestRegistry } from "./test-fixtures.js";

function worker(
  availability: readonly ScreenAvailability[] = [],
  sendsMeta = true,
  unsupported = false,
  openGate: Promise<void> = Promise.resolve(),
) {
  const clock = new FakeClock();
  const registry = new TestRegistry(
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
    [{ deviceId: "dev_leased", id: "lse_1" }],
  );
  const feeds: ScriptedFeed[] = [];
  let opened = 0;
  const handlers = new Map<string, ((envelope: { payload: { deviceId: string } }) => void)[]>();
  const stream = createWorkerStream({
    clock,
    events: {
      subscribe: (event, handler) => {
        const forEvent = handlers.get(event) ?? [];
        forEvent.push(handler as (typeof forEvent)[number]);
        handlers.set(event, forEvent);
        return () => undefined;
      },
    },
    instanceId: "w1",
    logger: new NoopLogger(),
    name: "stream",
    registry,
    screens: {
      openScreen: async () => {
        opened += 1;
        await openGate;
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
  const emit = (event: string, deviceId: string, payload: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(event) ?? []) {
      handler({ payload: { deviceId, ...payload } } as Parameters<typeof handler>[0]);
    }
  };
  return { clock, emit, feeds, opened: () => opened, registry, stream };
}

const STREAM_HEADERS = {
  "simlock-stream-codec": "h264",
  "simlock-stream-fps": "30",
  "simlock-stream-height": "720",
  "simlock-stream-width": "330",
};

const OPERATOR = { principal: "tok_op", role: "operator" };

const deviceRequest = (worker: string, device: string) =>
  new Request(`http://daemon/v1/stream/workers/${worker}/devices/${device}`);

const relayed = () => new Request("http://simlock-worker/stream/devices/dev_1");

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

  it("a relayed lease route answers 404 UNKNOWN_LEASE for a lease the worker does not hold", async () => {
    const { opened, stream } = worker();
    const answer = await stream.relayTarget(
      new Request("http://simlock-worker/stream/leases/lse_gone"),
      "gw:inst:agent-1",
    );
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({
      error: { code: "UNKNOWN_LEASE", message: "Unknown lease: lse_gone" },
    });
    expect(opened()).toBe(0);
  });

  it("gives a capture 30 s to send its first frame", async () => {
    const { clock, feeds, stream } = worker([], false);
    const served = stream.relayTarget(relayed(), "gw:inst:agent-1");
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
    const served = await stream.relayTarget(relayed(), "gw:inst:agent-1");
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

  it("stops a relayed capture when its lease ends", async () => {
    const { feeds, stream } = worker();
    const served = await stream.relayTarget(relayed(), "gw:inst:agent-1");
    expect(served.status).toBe(200);
    await stream.leaseEnd.leaseEnded(
      { deviceId: "dev_1", leaseId: "lse_1" } as Parameters<typeof stream.leaseEnd.leaseEnded>[0],
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

  it("answers an agent token asking for a device's stream with 404 UNKNOWN_DEVICE, on a worker and through a gateway, opening and relaying nothing", async () => {
    const agent = { principal: "tok_agent", role: "agent" };
    const { opened, stream } = worker();
    expect((await stream.mount.handle(deviceRequest("w1", "dev_1"), OPERATOR)).status).toBe(200);
    const onWorker = await stream.mount.handle(deviceRequest("w1", "dev_1"), agent);
    expect(onWorker.status).toBe(404);
    expect(await onWorker.json()).toEqual({
      error: { code: "UNKNOWN_DEVICE", message: "Unknown device: dev_1" },
    });
    expect(opened()).toBe(1);

    const relays: string[] = [];
    const gateway = createGatewayStream({
      fleet: {
        knowsWorker: () => true,
        relay: async (workerId) => {
          relays.push(workerId);
          return new Response(null, { status: 500 });
        },
        requesterPrefix: "gw:inst:",
      },
      logger: new NoopLogger(),
    });
    const throughGateway = await gateway.mount.handle(deviceRequest("w1", "dev_1"), agent);
    expect(throughGateway.status).toBe(404);
    expect(await throughGateway.json()).toEqual({
      error: { code: "UNKNOWN_DEVICE", message: "Unknown device: dev_1" },
    });
    expect(relays).toEqual([]);
    await gateway.mount.handle(deviceRequest("w1", "dev_1"), OPERATOR);
    expect(relays).toEqual(["w1"]);
  });

  it("relays an operator's device stream through a gateway, keeping the worker's refusal code, and refuses an unknown or disconnected worker", async () => {
    const refusal = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), { status });
    const answers: Record<string, () => Response | Promise<Response>> = {
      w1: () => new Response(new ReadableStream(), { headers: STREAM_HEADERS }),
      w_busy: () =>
        refusal(
          409,
          "DEVICE_NOT_RUNNING",
          "The device is shutdown; only a ready or leased device streams",
        ),
      w_missing: () => refusal(404, "UNKNOWN_DEVICE", "Unknown device: dev_9"),
      w_gone: () => {
        throw Object.assign(new Error("Worker w_gone is not connected"), {
          code: "WORKER_UNREACHABLE",
        });
      },
    };
    const relays: { workerId: string; url: string; tenant: string }[] = [];
    const gateway = createGatewayStream({
      fleet: {
        knowsWorker: (workerId) => workerId in answers,
        relay: async (workerId, call) => {
          relays.push({ tenant: call.tenant, url: call.request.url, workerId });
          return (answers[workerId] ?? (() => new Response(null, { status: 500 })))();
        },
        requesterPrefix: "gw:inst:",
      },
      logger: new NoopLogger(),
    });
    const ask = (workerId: string) =>
      gateway.mount.handle(deviceRequest(workerId, "dev_9"), OPERATOR);

    const served = await ask("w1");
    expect(served.status).toBe(200);
    expect(served.headers.get("simlock-stream-codec")).toBe("h264");
    await served.body?.cancel();
    expect(relays).toEqual([
      {
        tenant: "gw:inst:tok_op",
        url: "http://simlock-worker/stream/devices/dev_9",
        workerId: "w1",
      },
    ]);

    const expected: [string, number, string, string][] = [
      [
        "w_busy",
        409,
        "DEVICE_NOT_RUNNING",
        "The device is shutdown; only a ready or leased device streams",
      ],
      ["w_missing", 404, "UNKNOWN_DEVICE", "Unknown device: dev_9"],
      ["w_gone", 503, "WORKER_UNREACHABLE", "Worker w_gone is not connected"],
      ["w_nobody", 404, "UNKNOWN_WORKER", "Unknown worker: w_nobody"],
    ];
    for (const [workerId, status, code, message] of expected) {
      const refused = await ask(workerId);
      expect(refused.status, workerId).toBe(status);
      expect(await refused.json(), workerId).toEqual({ error: { code, message } });
    }
    expect(relays.map((relay) => relay.workerId)).toEqual(["w1", "w_busy", "w_missing", "w_gone"]);
  });

  it("follows its device: a lease granted leaves the stream running, a lease ended or a device that stops running ends the capture, and one that comes while the capture opens refuses with 409", async () => {
    {
      const { feeds, registry, stream } = worker();
      const ended = (leaseId: string) =>
        ({ deviceId: "dev_ready", leaseId }) as Parameters<typeof stream.leaseEnd.leaseEnded>[0];
      const served = await stream.mount.handle(deviceRequest("w1", "dev_ready"), OPERATOR);
      const reader = served.body!.getReader();
      await reader.read();

      registry.devices = registry.devices.map((device) =>
        device.id === "dev_ready" ? { ...device, state: "leased" } : device,
      );
      feeds[0]?.keyframe([9]);
      expect((await reader.read()).done).toBe(false);
      expect(feeds[0]?.closes).toBe(0);

      await stream.leaseEnd.leaseEnded(ended("lse_2"), new AbortController().signal);
      expect(feeds[0]?.closes).toBe(1);
      expect((await reader.read()).done).toBe(true);
    }

    {
      let openIt = () => {};
      const gate = new Promise<void>((resolve) => (openIt = resolve));
      const { feeds, stream } = worker([], true, false, gate);
      const asked = stream.mount.handle(deviceRequest("w1", "dev_ready"), OPERATOR);
      await settledWithin(asked);
      const ending = stream.leaseEnd.leaseEnded(
        { deviceId: "dev_ready", leaseId: "lse_3" } as Parameters<
          typeof stream.leaseEnd.leaseEnded
        >[0],
        new AbortController().signal,
      );
      openIt();
      const refused = await asked;
      await ending;
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "DEVICE_NOT_RUNNING",
      );
      expect(feeds[0]?.closes).toBe(1);
    }

    for (const event of [
      "device.shutdown",
      "device.absence-detected",
      "device.quarantined",
      "device.deleted",
    ]) {
      const { emit, feeds, stream } = worker();
      const watched = await stream.mount.handle(deviceRequest("w1", "dev_ready"), OPERATOR);
      const other = await stream.mount.handle(deviceRequest("w1", "dev_leased"), OPERATOR);
      const watchedReader = watched.body!.getReader();
      const otherReader = other.body!.getReader();
      await watchedReader.read();
      await otherReader.read();
      emit(event, "dev_ready");
      await settledWithin(Promise.resolve());
      expect(feeds[0]?.closes, event).toBe(1);
      expect((await watchedReader.read()).done, event).toBe(true);
      expect(feeds[1]?.closes, event).toBe(0);
      feeds[1]?.keyframe([5]);
      expect((await otherReader.read()).done, event).toBe(false);
      await otherReader.cancel();
    }

    {
      let openIt = () => {};
      const gate = new Promise<void>((resolve) => (openIt = resolve));
      const { emit, feeds, stream } = worker([], true, false, gate);
      const asked = stream.mount.handle(deviceRequest("w1", "dev_ready"), OPERATOR);
      await settledWithin(asked);
      emit("device.shutdown", "dev_ready");
      openIt();
      const refused = await asked;
      expect(refused.status).toBe(409);
      expect(feeds[0]?.closes).toBe(1);
    }

    {
      const { emit, feeds, stream } = worker([], false);
      const asked = stream.mount.handle(deviceRequest("w1", "dev_ready"), OPERATOR);
      await settledWithin(asked);
      expect(feeds).toHaveLength(1);
      emit("device.shutdown", "dev_ready");
      const refused = await asked;
      expect(refused.status).toBe(409);
      expect(feeds[0]?.closes).toBe(1);
    }
  });

  it("a viewer of either stream route sees a 0x07 frame with the reason, then the end, when the lease ends", async () => {
    const routes = {
      device: (stream: ReturnType<typeof worker>["stream"]) =>
        stream.mount.handle(deviceRequest("w1", "dev_leased"), OPERATOR),
      lease: (stream: ReturnType<typeof worker>["stream"]) =>
        stream.leaseRoute(
          new Request("http://daemon/v1/leases/lse_1/stream"),
          { principal: "tok_agent", role: "agent" },
          { deviceId: "dev_leased", id: "lse_1" },
        ),
    };
    const ending = (reason: string) =>
      ({ deviceId: "dev_leased", leaseId: "lse_1", reason }) as Parameters<
        ReturnType<typeof worker>["stream"]["leaseEnd"]["leaseEnded"]
      >[0];
    const cases = [
      { ended: "explicit", how: "released" },
      { ended: "expired", how: "expired" },
      { ended: "killed", how: "killed" },
      { ended: "device-lost", how: "health monitor" },
      { ended: "device-lost", how: "absence" },
    ] as const;
    // why: a device that was not leased going absent ends no lease, so no 0x07 frame is written.
    for (const [route, open] of Object.entries(routes)) {
      const { emit, stream } = worker();
      const reader = (await open(stream)).body!.getReader();
      expect((await reader.read()).value?.[4], route).toBe(SCREEN_FRAME_TAG.meta);
      emit("device.absence-detected", "dev_leased", { previousState: "ready" });
      await settledWithin(Promise.resolve());
      const last = await reader.read();
      expect([last.done, last.value], `${route} route, unleased absence`).toEqual([
        true,
        undefined,
      ]);
    }
    for (const [route, open] of Object.entries(routes)) {
      for (const { ended, how } of cases) {
        const label = `${route} route, ${how}`;
        const { emit, stream } = worker();
        const reader = (await open(stream)).body!.getReader();
        expect((await reader.read()).value?.[4], label).toBe(SCREEN_FRAME_TAG.meta);
        if (how === "absence") {
          emit("device.absence-detected", "dev_leased", { previousState: "leased" });
          await settledWithin(Promise.resolve());
        }
        await stream.leaseEnd.leaseEnded(ending(ended), new AbortController().signal);
        const last = await reader.read();
        expect(last.value?.[4], label).toBe(SCREEN_FRAME_TAG.ended);
        expect(
          JSON.parse(new TextDecoder().decode(last.value?.subarray(5))) as unknown,
          label,
        ).toEqual({ reason: ended });
        expect((await reader.read()).done, label).toBe(true);
      }
    }
  });
});
