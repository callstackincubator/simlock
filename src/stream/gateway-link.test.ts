import { describe, expect, it } from "vitest";

import type { StreamCaller } from "./caller.js";
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
  readonly signal: AbortSignal;
  readonly tenant: string;
  readonly url: string;
}

// why: each relay gets a body of its own, as a worker's answer does, so a test sees which viewers share one.
function relaying(headers: Record<string, string>, gate?: Promise<void>) {
  const calls: RelayCall[] = [];
  const port: FleetPort = {
    knowsWorker: (workerId) => workerId === "w1",
    relay: async (_workerId, call) => {
      calls.push({ signal: call.request.signal, tenant: call.tenant, url: call.request.url });
      if (calls.length === 1) await gate;
      const feed = new ScriptedFeed();
      feed.meta();
      return new Response(feed.body, { headers: streamHeaders(headers) });
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
