import type { CapturedStream } from "./capture.js";
import { relayedRefusal, unknownLease } from "./refusal.js";
import type { StreamLink } from "./service.js";

export interface StreamLeasePlacement {
  readonly ownerId: string;
  readonly requesterId: string;
  readonly workerLeaseId: string;
  readonly workerId: string;
}

export interface FleetPort {
  holder(leaseId: string): StreamLeasePlacement | undefined;
  // why: `gw:<this gateway's instance id>:`, the exact prefix this index recognizes a requester it
  // sent by, so a stream namespaces with the same value its leases do.
  readonly requesterPrefix: string;
  relay(workerId: string, request: Request, tenant: string, leaseId: string): Promise<Response>;
}

export interface GatewayStreamLinkOptions {
  readonly fleet: FleetPort;
}

const WORKER_STREAM_PATH = "/stream/leases/";

export function createGatewayStreamLink(options: GatewayStreamLinkOptions): StreamLink {
  return {
    async serve(leaseId, caller, signal): Promise<CapturedStream> {
      const held = options.fleet.holder(leaseId);
      if (held === undefined) throw unknownLease(leaseId);
      if (caller.role !== "operator" && held.ownerId !== caller.principal) {
        throw unknownLease(leaseId);
      }

      // why: the tenant is the same namespaced requester id `device.exec` forwards (ADR 0005 §27),
      // namespaced from the lease's own recorded requester rather than from the caller's claim -- so
      // a caller cannot reach a screen by naming someone else, and the worker proves ownership
      // against its own registry instead of trusting this relay.
      const namespacedRequesterId = `${options.fleet.requesterPrefix}${held.requesterId}`;
      const response = await options.fleet.relay(
        held.workerId,
        new Request(
          // why: the worker's own name for the lease, not the fleet id. A fleet id is this gateway's
          // naming and a worker knows nothing of it, so a request that reached the wrong lease would
          // be answered with the wrong screen rather than refused.
          `http://simlock-worker${WORKER_STREAM_PATH}${encodeURIComponent(held.workerLeaseId)}`,
          { method: "GET", signal },
        ),
        namespacedRequesterId,
        held.workerLeaseId,
      );
      return fromResponse(held.workerId, leaseId, response);
    },
  };
}

async function fromResponse(
  workerId: string,
  leaseId: string,
  response: Response,
): Promise<CapturedStream> {
  // why: the codec header is what tells a relayed stream from a relayed refusal -- a gateway reads a
  // stream's headers and never one video byte, which is also why a refusal is read as JSON here and a
  // picture never is.
  const codec = response.headers.get("simlock-stream-codec") ?? "";
  if (!response.ok || codec === "") {
    const reason = await response.text().catch(() => "");
    throw relayedRefusal(workerId, leaseId, response.status, reason);
  }
  if (response.body === null) {
    throw new Error(`Worker ${workerId} answered the stream for lease ${leaseId} with no body`);
  }
  return {
    body: response.body,
    // why: a browser that goes away aborts its request, which aborts the relay, which the worker
    // answers by killing its own capture -- so this cancel covers only the case where the gateway
    // itself gives up on a viewer of its own.
    close: () => response.body?.cancel().catch(() => undefined),
    meta: {
      codec: codec === "mjpeg" ? "mjpeg" : "h264",
      fps: numberHeader(response, "simlock-stream-fps"),
      height: numberHeader(response, "simlock-stream-height"),
      width: numberHeader(response, "simlock-stream-width"),
    },
  };
}

function numberHeader(response: Response, name: string): number {
  const raw = Number(response.headers.get(name));
  return Number.isFinite(raw) ? raw : 0;
}
