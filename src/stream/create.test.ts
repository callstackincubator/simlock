import { describe, expect, it } from "vitest";

import {
  encodeScreenFrame,
  type ScreenAvailability,
  SCREEN_FRAME_TAG,
  ScreenNotSupportedError,
  ScreenUnavailableError,
} from "../core/index.js";
import { FakeClock, NoopLogger } from "../ports/index.js";
import { createGatewayStream, createWorkerStream } from "./create.js";
import { ScriptedFeed, TestRegistry } from "./test-fixtures.js";

function worker(
  availability: readonly ScreenAvailability[] = [],
  sendsMeta = true,
  unsupported = false,
  openGate: Promise<void> = Promise.resolve(),
  failWith?: Error,
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
  const signals: AbortSignal[] = [];
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
      openScreen: async (_platform, _device, _settings, signal) => {
        opened += 1;
        signals.push(signal);
        await openGate;
        if (failWith !== undefined) throw failWith;
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
  return { clock, emit, feeds, opened: () => opened, registry, signals, stream };
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

const flush = () => settledWithin(Promise.resolve());

const FRAME_NAMES: Record<number, string> = {
  [SCREEN_FRAME_TAG.description]: "desc",
  [SCREEN_FRAME_TAG.keyframe]: "key",
  [SCREEN_FRAME_TAG.delta]: "delta",
  [SCREEN_FRAME_TAG.alive]: "alive",
  [SCREEN_FRAME_TAG.ended]: "ended",
};

function describeFrame(frame: Uint8Array): string {
  const payload = frame.subarray(5);
  if (frame[4] === SCREEN_FRAME_TAG.meta) {
    const meta = JSON.parse(new TextDecoder().decode(payload)) as { width: number; height: number };
    return `meta ${String(meta.width)}x${String(meta.height)}`;
  }
  const name = FRAME_NAMES[frame[4] ?? 0] ?? "?";
  return frame[4] === SCREEN_FRAME_TAG.ended
    ? `${name} ${new TextDecoder().decode(payload)}`
    : `${name} ${[...payload.subarray(0, 4)].join(",")}`;
}

// why: a viewer that reads whatever arrives, so a test asserts on what a viewer got instead of
// waiting on a read that may never be answered.
function watch(response: Response) {
  const seen = { ended: false, error: undefined as string | undefined, frames: [] as string[] };
  const reader = response.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) {
          seen.ended = true;
          return;
        }
        seen.frames.push(describeFrame(step.value));
      }
    } catch (error) {
      seen.error = (error as Error).message;
    }
  })();
  return seen;
}

function openOnRoute(
  stream: ReturnType<typeof worker>["stream"],
  route: "device" | "lease",
  expiresAt?: number,
): Promise<Response> {
  if (route === "device") {
    return stream.mount.handle(deviceRequest("w1", "dev_leased"), { ...OPERATOR, expiresAt });
  }
  return stream.leaseRoute(
    new Request("http://daemon/v1/leases/lse_1/stream"),
    { principal: "tok_agent", role: "agent", expiresAt },
    { deviceId: "dev_leased", id: "lse_1" },
  );
}

async function endsWhileFramesArrive(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  clock: FakeClock,
  feed: { keyframe(): void },
): Promise<boolean> {
  // why: a capture that writes nothing for 30 s ends on its own, so frames keep arriving.
  for (let step = 0; step < 4; step += 1) {
    const next = reader.read().then((result) => result.done === true);
    clock.advance(20_000);
    feed.keyframe();
    if ((await settledWithin(next)) === true) return true;
  }
  return false;
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
      clock: new FakeClock(),
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
      clock: new FakeClock(),
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

  it("ends a screen stream opened with an identity whose expiresAt is 1 minute ahead when the clock passes it, on either route; one opened without expiresAt keeps running past that time", async () => {
    for (const route of ["device", "lease"] as const) {
      for (const expires of [true, false]) {
        const label = `${route} route, ${expires ? "with" : "without"} expiresAt`;
        const { clock, feeds, stream } = worker();
        const served = await openOnRoute(stream, route, expires ? clock.now() + 60_000 : undefined);
        const reader = served.body!.getReader();
        await reader.read();
        const ended = await endsWhileFramesArrive(reader, clock, feeds[0]!);
        expect(ended, label).toBe(expires);
        if (expires) expect(clock.now(), label).toBe(60_000);
      }
    }
  });

  it("ends a screen stream the gateway relays for a proxy identity at that identity's expiresAt", async () => {
    const clock = new FakeClock();
    let relayCancelled = false;
    const gateway = createGatewayStream({
      clock,
      fleet: {
        knowsWorker: () => true,
        relay: async () => {
          const body = new ReadableStream<Uint8Array>({
            cancel: () => {
              relayCancelled = true;
            },
          });
          return new Response(body, { headers: STREAM_HEADERS });
        },
        requesterPrefix: "gw:inst:",
      },
      logger: new NoopLogger(),
    });
    const served = await gateway.mount.handle(deviceRequest("w1", "dev_9"), {
      ...OPERATOR,
      expiresAt: clock.now() + 60_000,
    });
    const next = served.body!.getReader().read();
    clock.advance(59_999);
    expect(await settledWithin(next)).toBe("pending");
    clock.advance(1);
    expect(await settledWithin(next)).toEqual({ done: true, value: undefined });
    expect(relayCancelled).toBe(true);

    // why: a stream that ends or is left before its deadline must not leave the deadline armed.
    const finished = createGatewayStream({
      clock,
      fleet: {
        knowsWorker: () => true,
        relay: async () => new Response(new Blob([]).stream(), { headers: STREAM_HEADERS }),
        requesterPrefix: "gw:inst:",
      },
      logger: new NoopLogger(),
    });
    const ending = await finished.mount.handle(deviceRequest("w1", "dev_9"), {
      ...OPERATOR,
      expiresAt: clock.now() + 60_000,
    });
    expect(await ending.body!.getReader().read()).toEqual({ done: true, value: undefined });
    expect(clock.pendingTimerCount).toBe(0);
    const left = await gateway.mount.handle(deviceRequest("w1", "dev_9"), {
      ...OPERATOR,
      expiresAt: clock.now() + 60_000,
    });
    expect(clock.pendingTimerCount).toBe(1);
    await left.body!.cancel();
    expect(clock.pendingTimerCount).toBe(0);

    // why: the same holds when the viewer cancels with its first frame already buffered (no read is
    // pending to finish the stream) and when the capture's body fails mid-stream.
    const bodies = {
      "a viewer that cancels with a frame buffered": () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array([1])),
        }),
      "a body that errors": () =>
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.error(new Error("capture failed")),
        }),
    };
    for (const [label, body] of Object.entries(bodies)) {
      const ended = createGatewayStream({
        clock,
        fleet: {
          knowsWorker: () => true,
          relay: async () => new Response(body(), { headers: STREAM_HEADERS }),
          requesterPrefix: "gw:inst:",
        },
        logger: new NoopLogger(),
      });
      const opened = await ended.mount.handle(deviceRequest("w1", "dev_9"), {
        ...OPERATOR,
        expiresAt: clock.now() + 60_000,
      });
      expect(clock.pendingTimerCount, label).toBe(1);
      await settledWithin(Promise.resolve());
      if (label === "a body that errors") {
        await expect(opened.body!.getReader().read()).rejects.toThrow("capture failed");
      } else await opened.body!.cancel();
      expect(clock.pendingTimerCount, label).toBe(0);
      expect(() => clock.advance(60_000), label).not.toThrow();
    }
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

  it("viewers of one device share one capture: each gets 200 with the current meta and a body of the current meta, the current parameter sets, then frames from the next key frame", async () => {
    const lease = (id: string) =>
      ({ deviceId: "dev_leased", leaseId: "lse_1", reason: id }) as Parameters<
        ReturnType<typeof worker>["stream"]["leaseEnd"]["leaseEnded"]
      >[0];
    const badMeta = encodeScreenFrame(
      SCREEN_FRAME_TAG.meta,
      new TextEncoder().encode(JSON.stringify({ codec: "vp9", fps: 30, height: 720, width: 330 })),
    );
    const routes = [
      ["two device-path viewers", "device", "device"],
      ["a device-path and a lease-path viewer", "device", "lease"],
    ] as const;
    for (const [label, first, second] of routes) {
      const { feeds, opened, stream } = worker();
      const a = await openOnRoute(stream, first);
      const b = await openOnRoute(stream, second);
      expect(opened(), label).toBe(1);
      for (const served of [a, b]) {
        expect(served.status, label).toBe(200);
        expect(Object.fromEntries(served.headers), label).toMatchObject(STREAM_HEADERS);
      }
      const seen = [watch(a), watch(b)];
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([1]);
      feeds[0]!.delta([2]);
      await flush();
      for (const viewer of seen) {
        expect(viewer.frames, label).toEqual(["meta 330x720", "desc 7", "key 1", "delta 2"]);
      }
    }

    {
      let openIt = () => {};
      const gate = new Promise<void>((resolve) => (openIt = resolve));
      const { opened, stream } = worker([], true, false, gate);
      const first = openOnRoute(stream, "device");
      const second = openOnRoute(stream, "lease");
      await flush();
      openIt();
      const seen = [watch(await first), watch(await second)];
      await flush();
      expect(opened(), "a second viewer while the first's open is pending").toBe(1);
      for (const viewer of seen) expect(viewer.frames).toEqual(["meta 330x720"]);
    }

    {
      const { feeds, stream } = worker();
      watch(await openOnRoute(stream, "device"));
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([1]);
      feeds[0]!.meta({ height: 800, width: 400 });
      feeds[0]!.description([8]);
      feeds[0]!.keyframe([2]);
      await flush();
      const joined = await openOnRoute(stream, "device");
      expect(joined.headers.get("simlock-stream-width"), "a joiner after a size change").toBe(
        "400",
      );
      expect(joined.headers.get("simlock-stream-height")).toBe("800");
      const viewer = watch(joined);
      feeds[0]!.delta([3]);
      feeds[0]!.frame(SCREEN_FRAME_TAG.alive, []);
      feeds[0]!.keyframe([4]);
      feeds[0]!.delta([5]);
      await flush();
      expect(viewer.frames).toEqual(["meta 400x800", "desc 8", "key 4", "delta 5"]);
    }

    {
      const { feeds, stream } = worker();
      watch(await openOnRoute(stream, "device"));
      const viewer = watch(await openOnRoute(stream, "lease"));
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([1]);
      await flush();
      expect(viewer.frames, "a joiner before any parameter sets").toEqual([
        "meta 330x720",
        "desc 7",
        "key 1",
      ]);
    }

    {
      const { feeds, stream } = worker();
      watch(await openOnRoute(stream, "device"));
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([1]);
      await flush();
      const viewer = watch(await openOnRoute(stream, "lease"));
      feeds[0]!.delta([2]);
      feeds[0]!.meta({ height: 800, width: 400 });
      feeds[0]!.description([8]);
      feeds[0]!.keyframe([3]);
      await flush();
      expect(viewer.frames, "a new meta and parameter sets before its first key frame").toEqual([
        "meta 330x720",
        "desc 7",
        "meta 400x800",
        "desc 8",
        "key 3",
      ]);
    }

    {
      const { feeds, stream } = worker();
      const early = watch(await openOnRoute(stream, "device"));
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([1]);
      await flush();
      const waiting = watch(await openOnRoute(stream, "lease"));
      await stream.leaseEnd.leaseEnded(lease("expired"), new AbortController().signal);
      await flush();
      for (const viewer of [early, waiting]) {
        expect(viewer.frames.at(-1), "the lease ending while it waits").toBe(
          'ended {"reason":"expired"}',
        );
        expect(viewer.ended).toBe(true);
      }
      expect(waiting.frames).toEqual(["meta 330x720", "desc 7", 'ended {"reason":"expired"}']);
    }

    {
      const { feeds, stream } = worker();
      const viewers = [
        watch(await openOnRoute(stream, "device")),
        watch(await openOnRoute(stream, "lease")),
      ];
      feeds[0]!.write(badMeta);
      await flush();
      for (const viewer of viewers) {
        expect(viewer.error, "a later meta frame that fails the check").toBe(
          "The screen capture names a codec this stream cannot carry: vp9",
        );
      }
    }

    {
      const { feeds, stream } = worker([], false);
      const first = openOnRoute(stream, "device");
      await flush();
      feeds[0]!.meta({ codec: "mjpeg" });
      const early = watch(await first);
      feeds[0]!.delta([1]);
      await flush();
      const joined = await openOnRoute(stream, "lease");
      expect(joined.headers.get("simlock-stream-codec"), "an MJPEG capture").toBe("mjpeg");
      const late = watch(joined);
      feeds[0]!.delta([2]);
      await flush();
      expect(early.frames).toEqual(["meta 330x720", "delta 1", "delta 2"]);
      expect(late.frames).toEqual(["meta 330x720", "delta 2"]);
    }

    {
      const { feeds, opened, stream } = worker();
      const viewer = await openOnRoute(stream, "device");
      const agent = { principal: "tok_agent", role: "agent" };
      const refused = [
        await stream.mount.handle(deviceRequest("w1", "dev_leased"), agent),
        await stream.mount.handle(deviceRequest("w1", "dev_nope"), OPERATOR),
        await stream.mount.handle(deviceRequest("w1", "dev_shutdown"), OPERATOR),
      ];
      expect(refused.map((answer) => answer.status)).toEqual([404, 404, 409]);
      expect(opened(), "a viewer refused by the device checks").toBe(1);
      await viewer.body!.cancel();
      await flush();
      expect(feeds[0]?.closes, "the refused viewers joined nothing").toBe(1);
    }
  });

  it("a stalled viewer never delays the capture or another viewer: past 2 MiB it drops its queued pictures and skips to the next key frame, and keeps meta, parameter sets and the lease-end frame", async () => {
    // why: 2 KiB a picture, so 1,100 of them are past the 2 MiB a viewer may queue.
    const picture = (index: number) => [
      index >> 8,
      index & 255,
      ...Array.from({ length: 2044 }, () => 0),
    ];
    const lease = (reason: string) =>
      ({ deviceId: "dev_leased", leaseId: "lse_1", reason }) as Parameters<
        ReturnType<typeof worker>["stream"]["leaseEnd"]["leaseEnded"]
      >[0];

    {
      const { feeds, stream } = worker();
      const fast = watch(await openOnRoute(stream, "device"));
      const stalled = await openOnRoute(stream, "lease");
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([0, 1]);
      feeds[0]!.frame(SCREEN_FRAME_TAG.alive, []);
      for (let index = 0; index < 2000; index += 1) feeds[0]!.delta(picture(index));
      feeds[0]!.meta({ height: 800, width: 400 });
      feeds[0]!.description([8]);
      feeds[0]!.keyframe([9, 9]);
      feeds[0]!.delta([9, 10]);
      await flush();
      expect(fast.frames, "another viewer reads every frame").toHaveLength(2008);
      expect(fast.frames).toContain("alive ");
      expect(fast.frames.at(-1)).toBe("delta 9,10");

      const reading = watch(stalled);
      await flush();
      expect(reading.frames, "the stalled viewer reading again").toEqual([
        "meta 330x720",
        "desc 7",
        "meta 400x800",
        "desc 8",
        "key 9,9",
        "delta 9,10",
      ]);
    }

    {
      const { feeds, stream } = worker();
      watch(await openOnRoute(stream, "device"));
      const stalled = await openOnRoute(stream, "lease");
      feeds[0]!.description([7]);
      feeds[0]!.keyframe([0, 1]);
      for (let index = 0; index < 1100; index += 1) feeds[0]!.delta(picture(index));
      await flush();
      await stream.leaseEnd.leaseEnded(lease("killed"), new AbortController().signal);
      const reading = watch(stalled);
      await flush();
      expect(reading.frames, "a full queue at a lease end").toEqual([
        "meta 330x720",
        "desc 7",
        'ended {"reason":"killed"}',
      ]);
      expect(reading.ended).toBe(true);
    }

    {
      const { feeds, stream } = worker([], false);
      const first = openOnRoute(stream, "device");
      const second = openOnRoute(stream, "lease");
      await flush();
      feeds[0]!.meta({ codec: "mjpeg" });
      watch(await first);
      const stalled = await second;
      for (let index = 0; index < 2000; index += 1) feeds[0]!.delta(picture(index));
      await flush();
      const reading = watch(stalled);
      feeds[0]!.delta(picture(2000));
      await flush();
      expect(reading.frames[0], "an MJPEG viewer past the bound").toBe("meta 330x720");
      expect(reading.frames.length).toBeLessThan(1500);
      expect(reading.frames).not.toContain("delta 0,0,0,0");
      expect(reading.frames.at(-1)).toBe("delta 7,208,0,0");
    }
  });

  const leaves1 = async () => {
    const { feeds, stream } = worker();
    const first = await openOnRoute(stream, "device");
    const second = await openOnRoute(stream, "lease");
    await first.body!.cancel();
    await flush();
    expect(feeds[0]?.closes, "the first leaves").toBe(0);
    await second.body!.cancel();
    await flush();
    expect(feeds[0]?.closes, "the second leaves").toBe(1);
  };

  const leaves2 = async () => {
    for (const [label, other] of [
      ["one viewer's expiresAt", true],
      ["the last viewer's expiresAt", false],
    ] as const) {
      const { clock, feeds, stream } = worker();
      const expiring = watch(await openOnRoute(stream, "device", clock.now() + 60_000));
      const staying = other ? watch(await openOnRoute(stream, "lease")) : undefined;
      // why: a capture that writes nothing for 30 s ends on its own, so frames keep arriving.
      for (let step = 0; step < 3; step += 1) {
        clock.advance(20_000);
        feeds[0]!.keyframe([step]);
        await flush();
      }
      expect(expiring.ended, label).toBe(true);
      if (staying === undefined) {
        expect(feeds[0]?.closes, label).toBe(1);
      } else {
        expect(feeds[0]?.closes, label).toBe(0);
        expect(staying.ended).toBe(false);
        feeds[0]!.keyframe([9]);
        await flush();
        expect(staying.frames.at(-1)).toBe("key 9");
      }
    }
  };

  const leaves3 = async () => {
    let openIt = () => {};
    const gate = new Promise<void>((resolve) => (openIt = resolve));
    const { feeds, signals, stream } = worker([], true, false, gate);
    const aborts = [new AbortController(), new AbortController()];
    const asked = [
      stream.mount.handle(
        new Request("http://daemon/v1/stream/workers/w1/devices/dev_leased", {
          signal: aborts[0]!.signal,
        }),
        OPERATOR,
      ),
      stream.leaseRoute(
        new Request("http://daemon/v1/leases/lse_1/stream", { signal: aborts[1]!.signal }),
        { principal: "tok_agent", role: "agent" },
        { deviceId: "dev_leased", id: "lse_1" },
      ),
    ];
    await flush();
    aborts[0]!.abort();
    await flush();
    expect(signals[0]?.aborted, "one leaves during the open and another stays").toBe(false);
    aborts[1]!.abort();
    await flush();
    expect(signals[0]?.aborted, "every viewer leaves during the open").toBe(true);
    openIt();
    await Promise.all(asked);
    await flush();
    expect(feeds[0]?.closes).toBe(1);
  };

  const leaves4 = async () => {
    let openIt = () => {};
    const gate = new Promise<void>((resolve) => (openIt = resolve));
    const { feeds, signals, stream } = worker([], true, false, gate);
    const leaving = new AbortController();
    const first = stream.mount.handle(
      new Request("http://daemon/v1/stream/workers/w1/devices/dev_leased", {
        signal: leaving.signal,
      }),
      OPERATOR,
    );
    const staying = openOnRoute(stream, "lease");
    await flush();
    leaving.abort();
    openIt();
    await first;
    const watching = watch(await staying);
    await flush();
    expect(signals[0]?.aborted).toBe(false);
    expect(watching.frames).toEqual(["meta 330x720"]);
    expect(feeds[0]?.closes).toBe(0);
  };

  it("closes the capture once, when its last viewer leaves: a viewer that leaves, or whose expiresAt passes, closes nothing while another watches", async () => {
    await leaves1();
    await leaves2();
    await leaves3();
    await leaves4();
  });

  it("a lease end or a device stop ends every viewer of the device as it ends one: each gets the lease-end frame when there is a reason, then the end, and the capture closes once", async () => {
    const leaseEnd = (stream: ReturnType<typeof worker>["stream"], reason: string) =>
      stream.leaseEnd.leaseEnded(
        { deviceId: "dev_leased", leaseId: "lse_1", reason } as Parameters<
          typeof stream.leaseEnd.leaseEnded
        >[0],
        new AbortController().signal,
      );
    const watchers = async (stream: ReturnType<typeof worker>["stream"], count: number) => {
      const routes = ["device", "lease", "device"] as const;
      const opened = [];
      for (let index = 0; index < count; index += 1) {
        opened.push(watch(await openOnRoute(stream, routes[index]!)));
      }
      return opened;
    };
    const endedFrames = (viewer: ReturnType<typeof watch>) =>
      viewer.frames.filter((frame) => frame.startsWith("ended"));

    {
      const { feeds, stream } = worker();
      const viewers = await watchers(stream, 3);
      await leaseEnd(stream, "explicit");
      await flush();
      for (const viewer of viewers) {
        expect(endedFrames(viewer), "a lease end with three viewers").toEqual([
          'ended {"reason":"explicit"}',
        ]);
        expect(viewer.ended).toBe(true);
      }
      expect(feeds[0]?.closes).toBe(1);
    }

    {
      const { emit, feeds, stream } = worker();
      const viewers = await watchers(stream, 2);
      emit("device.shutdown", "dev_leased");
      await flush();
      for (const viewer of viewers) {
        expect(viewer.ended, "device.shutdown with two viewers").toBe(true);
        expect(endedFrames(viewer)).toEqual([]);
      }
      expect(feeds[0]?.closes).toBe(1);
    }

    {
      const { emit, feeds, stream } = worker();
      const viewers = await watchers(stream, 2);
      emit("device.absence-detected", "dev_leased", { previousState: "leased" });
      await flush();
      await leaseEnd(stream, "device-lost");
      await flush();
      for (const viewer of viewers) {
        expect(endedFrames(viewer), "device.absence-detected on a leased device").toEqual([
          'ended {"reason":"device-lost"}',
        ]);
        expect(viewer.ended).toBe(true);
      }
      expect(feeds[0]?.closes).toBe(1);
    }

    {
      const { emit, feeds, opened, registry, stream } = worker();
      await watchers(stream, 1);
      emit("device.shutdown", "dev_leased");
      await flush();
      const again = watch(await openOnRoute(stream, "device"));
      await flush();
      expect(opened(), "a viewer that asks after the stop gets a fresh capture").toBe(2);
      expect(again.frames).toEqual(["meta 330x720"]);
      expect(feeds[1]?.closes).toBe(0);
      emit("device.shutdown", "dev_leased");
      registry.devices = registry.devices.map((device) =>
        device.id === "dev_leased" ? { ...device, state: "shutdown" } : device,
      );
      await flush();
      const refused = await openOnRoute(stream, "device");
      expect(refused.status).toBe(409);
      expect(opened()).toBe(2);
    }
  });

  const gated = () => {
    let openIt = () => {};
    const gate = new Promise<void>((resolve) => (openIt = resolve));
    return { gate, openIt: () => openIt() };
  };
  const refusal = async (answer: Response) => ({
    body: await answer.json(),
    status: answer.status,
  });

  const scenario1 = async () => {
    const { gate, openIt } = gated();
    const { opened, stream } = worker(
      [],
      true,
      false,
      gate,
      new ScreenUnavailableError("no encoder"),
    );
    const asked = [openOnRoute(stream, "device"), openOnRoute(stream, "lease")];
    await flush();
    openIt();
    const answers = await Promise.all(asked.map(async (answer) => refusal(await answer)));
    for (const answer of answers) {
      expect(answer, "a start that fails").toEqual({
        body: { error: { code: "STREAM_UNAVAILABLE", message: "no encoder" } },
        status: 503,
      });
    }
    expect(opened()).toBe(1);
    const again = await settledWithin(openOnRoute(stream, "device"));
    expect(again === "pending" ? again : again.status, "a viewer after a failed start").toBe(503);
    expect(opened()).toBe(2);
  };

  const scenario2 = async () => {
    const { clock, feeds, opened, stream } = worker([], false);
    const asked = [openOnRoute(stream, "device"), openOnRoute(stream, "lease")];
    await flush();
    clock.advance(30_000);
    const answers = await Promise.all(asked.map(async (answer) => refusal(await answer)));
    expect(
      answers.map((answer) => answer.status),
      "the start bound",
    ).toEqual([503, 503]);
    expect(answers[1]).toEqual(answers[0]);
    expect(opened()).toBe(1);
    expect(feeds[0]?.closes).toBe(1);
  };

  const scenario3 = async () => {
    const { gate, openIt } = gated();
    const { emit, feeds, stream } = worker([], true, false, gate);
    const asked = [openOnRoute(stream, "device"), openOnRoute(stream, "lease")];
    await flush();
    emit("device.shutdown", "dev_leased");
    openIt();
    const answers = await Promise.all(asked.map(async (answer) => refusal(await answer)));
    for (const answer of answers) {
      expect(answer.status, "the device stopping during a shared start").toBe(409);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(feeds[0]?.closes).toBe(1);
  };

  const scenario4 = async () => {
    const { feeds, opened, stream } = worker();
    const viewers = [
      watch(await openOnRoute(stream, "device")),
      watch(await openOnRoute(stream, "lease")),
    ];
    const unread = await openOnRoute(stream, "device");
    feeds[0]!.fail(new Error("encoder crashed"));
    await flush();
    for (const viewer of viewers) {
      expect(viewer.error, "a mid-stream read error").toBe("encoder crashed");
    }
    expect(feeds[0]?.closes).toBe(1);
    const fresh = watch(await openOnRoute(stream, "device"));
    await flush();
    expect(opened(), "a new open after a failure, while an errored body is unread").toBe(2);
    expect(fresh.frames).toEqual(["meta 330x720"]);
    await expect(unread.body!.getReader().read()).rejects.toThrow("encoder crashed");
  };

  const scenario5 = async () => {
    const { clock, feeds, stream } = worker();
    const viewers = [
      watch(await openOnRoute(stream, "device")),
      watch(await openOnRoute(stream, "lease")),
    ];
    clock.advance(29_999);
    await flush();
    expect(viewers.map((viewer) => viewer.error)).toEqual([undefined, undefined]);
    clock.advance(1);
    await flush();
    for (const viewer of viewers) {
      expect(viewer.error, "the silence bound").toBe(
        "The screen capture wrote nothing for 30000ms while waiting for the next frame",
      );
    }
    expect(feeds[0]?.closes).toBe(1);
  };

  it("a capture that fails fails every viewer it serves the same way, and the next viewer starts a fresh capture", async () => {
    await scenario1();
    await scenario2();
    await scenario3();
    await scenario4();
    await scenario5();
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
