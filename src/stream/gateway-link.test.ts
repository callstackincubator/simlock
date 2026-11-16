import { describe, expect, it } from "vitest";

import { encodeScreenFrame, encodeScreenMeta, SCREEN_FRAME_TAG } from "../core/index.js";
import type { StreamCaller } from "./caller.js";
import type { CapturedStream } from "./feed.js";
import { createGatewayStreamLink, type FleetPort } from "./gateway-link.js";
import { StreamRefusalError } from "./refusal.js";
import { ScriptedFeed } from "./test-fixtures.js";

const OPERATOR: StreamCaller = { principal: "tok_op", role: "operator" };
const DEVICE = { deviceId: "dev_9", workerId: "w1" };

interface Relayed {
  readonly workerId: string;
  readonly url: string;
  readonly tenant: string;
}

class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fleet(answer: () => Response): { port: FleetPort; relayed: Relayed[] } {
  const relayed: Relayed[] = [];
  return {
    port: {
      knowsWorker: () => true,
      relay: async (workerId, call) => {
        relayed.push({ tenant: call.tenant, url: call.request.url, workerId });
        return answer();
      },
      requesterPrefix: "gw:inst:",
    },
    relayed,
  };
}

function streamHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "simlock-stream-codec": "h264",
    "simlock-stream-fps": "30",
    "simlock-stream-height": "720",
    "simlock-stream-width": "330",
    ...overrides,
  };
}

async function refusalOf(served: Promise<unknown>): Promise<StreamRefusalError> {
  const outcome = await served.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome, "the stream was expected to be refused").toBeInstanceOf(StreamRefusalError);
  return outcome as StreamRefusalError;
}

const HOLDER: StreamCaller = { principal: "tok_agent", role: "agent" };

const signal = () => new AbortController().signal;

describe("the gateway's stream link", () => {
  it("relays to the worker named, for the operator's namespaced principal, and describes the picture from its headers", async () => {
    const { port, relayed } = fleet(() => new Response("bytes", { headers: streamHeaders() }));
    const stream = await createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal());
    expect(relayed).toEqual([
      {
        tenant: "gw:inst:tok_op",
        url: "http://simlock-worker/stream/devices/dev_9",
        workerId: "w1",
      },
    ]);
    expect(stream.meta).toEqual({ codec: "h264", fps: 30, height: 720, width: 330 });
  });

  it("forwards the worker's own refusal code and status", async () => {
    const { port } = fleet(() =>
      Response.json(
        { error: { code: "STREAM_NOT_SUPPORTED", message: "A physical phone cannot" } },
        { status: 415 },
      ),
    );
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
    );
    expect([refusal.status, refusal.code, refusal.message]).toEqual([
      415,
      "STREAM_NOT_SUPPORTED",
      "A physical phone cannot",
    ]);
  });

  it("does not forward a refusal code that is not shaped like one of ours", async () => {
    const { port } = fleet(() =>
      Response.json({ error: { code: "<script>", message: "x" } }, { status: 503 }),
    );
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([503, "STREAM_UNAVAILABLE"]);
    expect(refusal.message).not.toContain("<script>");
  });

  it("reads no more of a refusal body than its cap", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const { port } = fleet(() => new Response(endless, { status: 503 }));
    await refusalOf(createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()));
    expect(pulled).toBeLessThanOrEqual(17);
  });

  it("calls a 2xx answer without a picture the gateway's own failure, not the worker refusing", async () => {
    const { port } = fleet(() => new Response("ok", { status: 200 }));
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([502, "STREAM_UNAVAILABLE"]);
  });

  it("calls a 2xx answer with a picture's headers but no body the gateway's own failure", async () => {
    const { port } = fleet(() => new Response(null, { headers: streamHeaders(), status: 200 }));
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([502, "STREAM_UNAVAILABLE"]);
  });

  it("refuses a relayed picture whose codec or size it cannot describe", async () => {
    for (const headers of [
      streamHeaders({ "simlock-stream-codec": "vp9" }),
      streamHeaders({ "simlock-stream-width": "99999999" }),
      streamHeaders({ "simlock-stream-height": "" }),
    ]) {
      const { port } = fleet(() => new Response("bytes", { headers }));
      const refusal = await refusalOf(
        createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
      );
      expect(refusal.code).toBe("STREAM_UNAVAILABLE");
    }
  });

  it("answers a worker the relay cannot reach with 503 and the relay's own code", async () => {
    const { port } = fleet(() => {
      throw new CodedError("WORKER_UNREACHABLE", "worker w1 is not connected");
    });
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
    );
    expect([refusal.status, refusal.code, refusal.message]).toEqual([
      503,
      "WORKER_UNREACHABLE",
      "worker w1 is not connected",
    ]);
  });

  it("answers a worker that serves no stream with 503 STREAM_UNAVAILABLE naming the worker", async () => {
    const { port } = fleet(() => {
      throw new CodedError("RELAY_TARGET_MISSING", "No module on this worker serves stream");
    });
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(DEVICE, OPERATOR, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([503, "STREAM_UNAVAILABLE"]);
    expect(refusal.message).toContain("Worker w1");
  });

  // why: a gateway holds a lease the worker has already dropped only for the moment between the two
  // views, which two real daemons cannot be held open in, so the worker is a relay that answers as it.
  it("a lease the worker no longer holds is 404 UNKNOWN_LEASE naming the lease the caller asked for", async () => {
    const { port, relayed } = fleet(() =>
      Response.json(
        { error: { code: "UNKNOWN_LEASE", message: "Unknown lease: lse_7" } },
        { status: 404 },
      ),
    );
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve(
        { leaseId: "w1.lse_7", workerId: "w1", workerLeaseId: "lse_7" },
        HOLDER,
        signal(),
      ),
    );
    expect(relayed.map((call) => call.url)).toEqual(["http://simlock-worker/stream/leases/lse_7"]);
    expect([refusal.status, refusal.code, refusal.message]).toEqual([
      404,
      "UNKNOWN_LEASE",
      "Unknown lease: w1.lse_7",
    ]);
  });
});

const PROMISE = { "simlock-stream-keyframe-ms": "5000" };
const LEASE = { leaseId: "w1.lse_7", workerId: "w1", workerLeaseId: "lse_7" };
const flush = () => new Promise((resolve) => setImmediate(resolve));

interface RelayCall {
  readonly aborts: () => number;
  readonly signal: AbortSignal;
  readonly tenant: string;
  readonly url: string;
}

// why: each relay gets a body of its own, as a worker's answer does, so a test sees which viewers share one.
function relaying(headers: Record<string, string>, gate?: Promise<void>) {
  const calls: RelayCall[] = [];
  const feeds: ScriptedFeed[] = [];
  const port: FleetPort = {
    knowsWorker: (workerId) => workerId === "w1",
    relay: async (_workerId, call) => {
      let aborted = 0;
      call.request.signal.addEventListener("abort", () => (aborted += 1));
      calls.push({
        aborts: () => aborted,
        signal: call.request.signal,
        tenant: call.tenant,
        url: call.request.url,
      });
      if (calls.length === 1) await gate;
      const feed = new ScriptedFeed();
      feeds.push(feed);
      feed.meta();
      return new Response(feed.body, { headers: streamHeaders(headers) });
    },
    requesterPrefix: "gw:inst:",
  };
  return { calls, feeds, link: createGatewayStreamLink({ fleet: port }) };
}

// why: a fleet that answers whatever the test says, to every relay.
function relayingAs(answer: () => Response | Promise<Response>) {
  const calls: RelayCall[] = [];
  const port: FleetPort = {
    knowsWorker: () => true,
    relay: async (_workerId, call) => {
      let aborted = 0;
      call.request.signal.addEventListener("abort", () => (aborted += 1));
      calls.push({
        aborts: () => aborted,
        signal: call.request.signal,
        tenant: call.tenant,
        url: call.request.url,
      });
      return await answer();
    },
    requesterPrefix: "gw:inst:",
  };
  return { calls, link: createGatewayStreamLink({ fleet: port }) };
}

describe("viewers of one target through the gateway's stream link", () => {
  it("share one relay per worker and target once the worker promises key frames, and each of a worker that does not has its own", async () => {
    const shared = relaying(PROMISE);
    for (let viewer = 0; viewer < 3; viewer += 1) {
      await shared.link.serve(DEVICE, OPERATOR, signal());
    }
    expect(shared.calls.map((call) => call.url)).toEqual([
      "http://simlock-worker/stream/devices/dev_9",
    ]);

    await shared.link.serve(LEASE, HOLDER, signal());
    await shared.link.serve(LEASE, OPERATOR, signal());
    expect(shared.calls.map((call) => call.url)).toEqual([
      "http://simlock-worker/stream/devices/dev_9",
      "http://simlock-worker/stream/leases/lse_7",
    ]);

    await refusalOf(shared.link.serve(DEVICE, HOLDER, signal()));
    await refusalOf(shared.link.serve({ ...DEVICE, workerId: "w_nobody" }, OPERATOR, signal()));
    expect(shared.calls).toHaveLength(2);

    for (const headers of [{}, { "simlock-stream-keyframe-ms": "4999" }]) {
      const alone = relaying(headers);
      const first = new AbortController();
      const second = new AbortController();
      await alone.link.serve(DEVICE, OPERATOR, first.signal);
      await alone.link.serve(DEVICE, OPERATOR, second.signal);
      expect(alone.calls).toHaveLength(2);
      first.abort();
      expect(alone.calls.map((call) => call.signal.aborted)).toEqual([true, false]);
      second.abort();
      expect(alone.calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    }

    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting = relaying({}, gate);
    const first = new AbortController();
    const second = new AbortController();
    const a = waiting.link.serve(DEVICE, OPERATOR, first.signal);
    const b = waiting.link.serve(DEVICE, OPERATOR, second.signal);
    await flush();
    expect(waiting.calls).toHaveLength(1);
    release();
    await Promise.all([a, b]);
    expect(waiting.calls).toHaveLength(2);
    first.abort();
    expect(waiting.calls.map((call) => call.signal.aborted)).toEqual([true, false]);
    second.abort();
    expect(waiting.calls.map((call) => call.signal.aborted)).toEqual([true, true]);
  });
});

const FRAME_NAMES: Record<number, string> = {
  [SCREEN_FRAME_TAG.description]: "desc",
  [SCREEN_FRAME_TAG.keyframe]: "key",
  [SCREEN_FRAME_TAG.delta]: "delta",
};

// why: a viewer that reads whatever arrives, so a test asserts on what it got instead of waiting on a read.
function watch(stream: CapturedStream) {
  const seen = { ended: false, frames: [] as string[] };
  const reader = stream.body.getReader();
  void (async () => {
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      const frame = step.value;
      if (frame[4] === SCREEN_FRAME_TAG.meta) {
        const meta = JSON.parse(new TextDecoder().decode(frame.subarray(5))) as {
          height: number;
          width: number;
        };
        seen.frames.push(`meta ${String(meta.width)}x${String(meta.height)}`);
      } else seen.frames.push(`${FRAME_NAMES[frame[4] ?? 0] ?? "?"} ${String(frame[5])}`);
    }
    seen.ended = true;
  })();
  return seen;
}

describe("a shared relay's viewers", () => {
  it("get a joiner's meta, parameter sets and next key frame, a slow viewer's skip to its next key frame, and the relay ends with its last viewer", async () => {
    const joined = relaying(PROMISE);
    const first = new AbortController();
    const seenA = watch(await joined.link.serve(DEVICE, OPERATOR, first.signal));
    const feed = joined.feeds[0]!;
    feed.description([7]);
    feed.keyframe([1]);
    feed.delta([2]);
    await flush();
    const seenB = watch(await joined.link.serve(DEVICE, OPERATOR, signal()));
    feed.delta([3]);
    feed.keyframe([4]);
    feed.delta([5]);
    await flush();
    expect(seenA.frames).toEqual([
      "meta 330x720",
      "desc 7",
      "key 1",
      "delta 2",
      "delta 3",
      "key 4",
      "delta 5",
    ]);
    expect(seenB.frames).toEqual(["meta 330x720", "desc 7", "key 4", "delta 5"]);

    feed.meta({ height: 800 });
    await flush();
    const late = await joined.link.serve(DEVICE, OPERATOR, signal());
    expect(late.meta.height).toBe(800);
    const seenLate = watch(late);
    await flush();
    expect(seenLate.frames).toEqual(["meta 330x800", "desc 7"]);
    feed.delta([6]);
    feed.keyframe([8]);
    await flush();
    expect(seenLate.frames.slice(2)).toEqual(["key 8"]);

    first.abort();
    feed.delta([9]);
    await flush();
    expect(seenB.frames.at(-1)).toBe("delta 9");
    expect(joined.calls.map((call) => call.aborts())).toEqual([0]);

    const stalled = relaying(PROMISE);
    const slow = await stalled.link.serve(DEVICE, OPERATOR, signal());
    const seenLive = watch(await stalled.link.serve(DEVICE, OPERATOR, signal()));
    const live = stalled.feeds[0]!;
    live.keyframe([1]);
    for (const n of [2, 3, 4, 5]) {
      live.delta([n, ...Array.from({ length: 700_000 }, () => 0)]);
      await flush();
    }
    live.keyframe([9]);
    live.delta([10]);
    await flush();
    expect(seenLive.frames).toEqual([
      "meta 330x720",
      "key 1",
      "delta 2",
      "delta 3",
      "delta 4",
      "delta 5",
      "key 9",
      "delta 10",
    ]);
    const seenSlow = watch(slow);
    await flush();
    expect(seenSlow.frames).toEqual(["meta 330x720", "key 9", "delta 10"]);
  });

  it("leaving ends the relay once, with its last viewer, even while the worker's head is awaited", async () => {
    const leaving = relaying(PROMISE);
    const [one, two] = [new AbortController(), new AbortController()];
    await leaving.link.serve(DEVICE, OPERATOR, one.signal);
    await leaving.link.serve(DEVICE, OPERATOR, two.signal);
    one.abort();
    leaving.feeds[0]!.delta([1]);
    await flush();
    expect(leaving.calls.map((call) => call.aborts())).toEqual([0]);
    two.abort();
    await flush();
    expect(leaving.calls.map((call) => call.aborts())).toEqual([1]);

    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting = relaying(PROMISE, gate);
    const [x, y] = [new AbortController(), new AbortController()];
    const ended = (served: Promise<unknown>) =>
      served.then(
        () => "served",
        (error: unknown) => (error as Error).name,
      );
    const a = ended(waiting.link.serve(DEVICE, OPERATOR, x.signal));
    const b = ended(waiting.link.serve(DEVICE, OPERATOR, y.signal));
    await flush();
    x.abort();
    await flush();
    expect(waiting.calls.map((call) => call.aborts())).toEqual([0]);
    y.abort();
    await flush();
    expect(waiting.calls.map((call) => call.aborts())).toEqual([1]);
    expect(await Promise.all([a, b])).toEqual(["AbortError", "AbortError"]);
    const next = waiting.link.serve(DEVICE, OPERATOR, signal()).then(() => "served");
    expect(await Promise.race([next, flush().then(() => "waiting")])).toBe("served");
    expect(waiting.calls).toHaveLength(2);
    release();
    await flush();
    expect(waiting.calls.map((call) => call.aborts())).toEqual([1, 0]);
  });
});

const META = { codec: "h264", fps: 30, height: 720, width: 330 } as const;
const frameHeader = (length: number, tag: number) => {
  const bytes = new Uint8Array(5);
  new DataView(bytes.buffer).setUint32(0, length);
  bytes[4] = tag;
  return bytes;
};
const bodyOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

// why: a viewer read to its end, whatever ends it, so a test compares what two viewers were each told.
async function told(stream: CapturedStream): Promise<{ frames: number; error?: string }> {
  const reader = stream.body.getReader();
  let frames = 0;
  try {
    for (let step = await reader.read(); !step.done; step = await reader.read()) frames += 1;
    return { frames };
  } catch (error) {
    return { error: (error as Error).message, frames };
  }
}

describe("a shared relay that is refused or fails", () => {
  it("refuses or ends every viewer waiting on it the same way", async () => {
    const refusals: [string, () => Response | Promise<Response>, number, string, string][] = [
      [
        "a refusal",
        () =>
          Response.json(
            { error: { code: "DEVICE_NOT_RUNNING", message: "The device is shutdown" } },
            { status: 409 },
          ),
        409,
        "DEVICE_NOT_RUNNING",
        "The device is shutdown",
      ],
      [
        "an unreachable worker",
        () => {
          throw new CodedError("WORKER_UNREACHABLE", "worker w1 is not connected");
        },
        503,
        "WORKER_UNREACHABLE",
        "worker w1 is not connected",
      ],
    ];
    for (const [label, answer, status, code, message] of refusals) {
      const shared = relayingAs(answer);
      const both = await Promise.all([
        refusalOf(shared.link.serve(DEVICE, OPERATOR, signal())),
        refusalOf(shared.link.serve(DEVICE, OPERATOR, signal())),
      ]);
      expect(shared.calls, label).toHaveLength(1);
      for (const refusal of both) {
        expect([refusal.status, refusal.code, refusal.message], label).toEqual([
          status,
          code,
          message,
        ]);
      }
    }

    const meta = encodeScreenMeta(META);
    const key = encodeScreenFrame(SCREEN_FRAME_TAG.keyframe, Uint8Array.of(1));
    const ended = encodeScreenFrame(
      SCREEN_FRAME_TAG.ended,
      new TextEncoder().encode('{"reason":"explicit"}'),
    );
    const brokenMeta = encodeScreenFrame(
      SCREEN_FRAME_TAG.meta,
      new TextEncoder().encode(JSON.stringify({ ...META, codec: "vp9" })),
    );
    const bodies: [string, Uint8Array[], string | undefined][] = [
      [
        "a frame over the bound",
        [meta, frameHeader(9_000_000, SCREEN_FRAME_TAG.delta)],
        "The screen stream sent a frame of 9000004 bytes, over the 8388608 a frame may be",
      ],
      [
        "a frame of length 0",
        [meta, frameHeader(0, SCREEN_FRAME_TAG.delta)],
        "The screen stream's output is not a frame envelope",
      ],
      [
        "a first frame that is not meta",
        [key],
        "The screen stream does not begin with a meta frame",
      ],
      [
        "a later meta frame that fails the check",
        [meta, brokenMeta],
        "The screen capture names a codec this stream cannot carry: vp9",
      ],
      ["the body ending", [meta, key, ended], undefined],
    ];
    for (const [label, chunks, error] of bodies) {
      const shared = relayingAs(
        () => new Response(bodyOf(...chunks), { headers: streamHeaders(PROMISE) }),
      );
      const both = await Promise.all([
        shared.link.serve(DEVICE, OPERATOR, signal()),
        shared.link.serve(DEVICE, OPERATOR, signal()),
      ]);
      const outcomes = await Promise.all(both.map(told));
      expect(outcomes, label).toEqual(
        error === undefined
          ? [{ frames: 3 }, { frames: 3 }]
          : [
              { error, frames: 0 },
              { error, frames: 0 },
            ],
      );
      await flush();
      expect(
        shared.calls.map((call) => call.aborts()),
        label,
      ).toEqual([1]);
    }
  });
});
