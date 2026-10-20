import { describe, expect, it } from "vitest";

import type { StreamCaller } from "./caller.js";
import { createGatewayStreamLink, type FleetPort } from "./gateway-link.js";
import { StreamRefusalError } from "./refusal.js";

const AGENT: StreamCaller = { principal: "tok_agent", role: "agent" };
const STRANGER: StreamCaller = { principal: "tok_other", role: "agent" };

interface Relayed {
  readonly workerId: string;
  readonly url: string;
  readonly tenant: string;
  readonly leaseId: string;
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
      holder: (leaseId) =>
        leaseId === "w1.lse_9"
          ? { ownerId: "tok_agent", requesterId: "agent-1", workerId: "w1", workerLeaseId: "lse_9" }
          : undefined,
      relay: async (workerId, call) => {
        relayed.push({
          leaseId: call.leaseId,
          tenant: call.tenant,
          url: call.request.url,
          workerId,
        });
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

const signal = () => new AbortController().signal;

describe("the gateway's stream link", () => {
  it("relays to the worker holding the lease, by the worker's own lease id, as the lease's namespaced requester", async () => {
    const { port, relayed } = fleet(() => new Response("bytes", { headers: streamHeaders() }));
    const stream = await createGatewayStreamLink({ fleet: port }).serve(
      "w1.lse_9",
      AGENT,
      signal(),
    );
    expect(relayed).toEqual([
      {
        leaseId: "lse_9",
        tenant: "gw:inst:agent-1",
        url: "http://simlock-worker/stream/leases/lse_9",
        workerId: "w1",
      },
    ]);
    expect(stream.meta).toEqual({ codec: "h264", fps: 30, height: 720, width: 330 });
  });

  it("answers a lease the fleet does not hold with 404 UNKNOWN_LEASE, relaying nothing", async () => {
    const { port, relayed } = fleet(() => new Response("bytes", { headers: streamHeaders() }));
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_ended", AGENT, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([404, "UNKNOWN_LEASE"]);
    expect(relayed).toEqual([]);
  });

  it("answers a caller who does not own the lease exactly as an unknown lease, relaying nothing", async () => {
    const { port, relayed } = fleet(() => new Response("bytes", { headers: streamHeaders() }));
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", STRANGER, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([404, "UNKNOWN_LEASE"]);
    expect(relayed).toEqual([]);
  });

  it("forwards the worker's own refusal code and status", async () => {
    const { port } = fleet(() =>
      Response.json(
        { error: { code: "STREAM_NOT_SUPPORTED", message: "A physical phone cannot" } },
        { status: 415 },
      ),
    );
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
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
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
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
    await refusalOf(createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()));
    expect(pulled).toBeLessThanOrEqual(17);
  });

  it("calls a 2xx answer without a picture the gateway's own failure, not the worker refusing", async () => {
    const { port } = fleet(() => new Response("ok", { status: 200 }));
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([502, "STREAM_UNAVAILABLE"]);
  });

  it("calls a 2xx answer with a picture's headers but no body the gateway's own failure", async () => {
    const { port } = fleet(() => new Response(null, { headers: streamHeaders(), status: 200 }));
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
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
        createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
      );
      expect(refusal.code).toBe("STREAM_UNAVAILABLE");
    }
  });

  it("answers a worker the relay cannot reach with 503 and the relay's own code", async () => {
    const { port } = fleet(() => {
      throw new CodedError("WORKER_UNREACHABLE", "worker w1 is not connected");
    });
    const refusal = await refusalOf(
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
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
      createGatewayStreamLink({ fleet: port }).serve("w1.lse_9", AGENT, signal()),
    );
    expect([refusal.status, refusal.code]).toEqual([503, "STREAM_UNAVAILABLE"]);
    expect(refusal.message).toContain("Worker w1");
  });
});
