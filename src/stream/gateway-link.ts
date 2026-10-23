import type { ScreenMeta } from "../core/index.js";
import type { StreamCaller } from "./caller.js";
import type { CapturedStream } from "./feed.js";
import { checkedMeta } from "./framing.js";
import {
  relayedRefusal,
  StreamRefusalError,
  streamUnavailable,
  unknownDevice,
  unknownLease,
  unknownWorker,
} from "./refusal.js";
import type { StreamDeviceTarget, StreamLink } from "./service.js";

export interface StreamLeasePlacement {
  readonly ownerId: string;
  readonly requesterId: string;
  readonly workerLeaseId: string;
  readonly workerId: string;
}

export interface FleetPort {
  holder(leaseId: string): StreamLeasePlacement | undefined;
  knowsWorker(workerId: string): boolean;
  // why: `gw:<this gateway's instance id>:`, the exact prefix this index recognizes a requester it
  // sent by, so a stream namespaces with the same value its leases do.
  readonly requesterPrefix: string;
  relay(
    workerId: string,
    call: {
      readonly request: Request;
      readonly tenant: string;
      readonly leaseId?: string;
    },
  ): Promise<Response>;
}

export interface GatewayStreamLinkOptions {
  readonly fleet: FleetPort;
}

const WORKER_STREAM_PATH = "/stream/leases/";

export function createGatewayStreamLink(options: GatewayStreamLinkOptions): StreamLink {
  return {
    async serve(target, caller, signal): Promise<CapturedStream> {
      if (typeof target !== "string") return serveDevice(options, target, caller, signal);
      const leaseId = target;
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
      const response = await relayed(held.workerId, `lease ${leaseId}`, () =>
        options.fleet.relay(held.workerId, {
          leaseId: held.workerLeaseId,
          request: new Request(
            // why: the worker's own name for the lease, not the fleet id. A fleet id is this gateway's
            // naming and a worker knows nothing of it, so a request that reached the wrong lease would
            // be answered with the wrong screen rather than refused.
            `http://simlock-worker${WORKER_STREAM_PATH}${encodeURIComponent(held.workerLeaseId)}`,
            { method: "GET", signal },
          ),
          tenant: namespacedRequesterId,
        }),
      );
      return fromResponse(held.workerId, `lease ${leaseId}`, response);
    },
  };
}

async function serveDevice(
  options: GatewayStreamLinkOptions,
  target: StreamDeviceTarget,
  caller: StreamCaller,
  signal: AbortSignal,
): Promise<CapturedStream> {
  // why: the same refusal an unknown device gets, before any relay, so an agent cannot reach a screen
  // by naming a device.
  if (caller.role !== "operator") throw unknownDevice(target.deviceId);
  const workerId = target.workerId ?? "";
  if (!options.fleet.knowsWorker(workerId)) throw unknownWorker(workerId);
  const response = await relayed(workerId, `device ${target.deviceId}`, () =>
    options.fleet.relay(workerId, {
      request: new Request(
        `http://simlock-worker/stream/devices/${encodeURIComponent(target.deviceId)}`,
        { method: "GET", signal },
      ),
      tenant: `${options.fleet.requesterPrefix}${caller.principal}`,
    }),
  );
  return fromResponse(workerId, `device ${target.deviceId}`, response);
}

// why: the relay fails with the fleet's own codes -- a worker gone (`WORKER_UNREACHABLE`), a worker
// that serves no stream (`RELAY_TARGET_MISSING`) -- and a viewer must get the picture's 503 with
// that reason rather than a 500 that says nothing; anything without a code is a real fault.
async function relayed(
  workerId: string,
  subject: string,
  relay: () => Promise<Response>,
): Promise<Response> {
  try {
    return await relay();
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "RELAY_TARGET_MISSING") {
      throw streamUnavailable(
        `Worker ${workerId} does not serve screen streams for ${subject}; turn on capabilities.stream.enabled there`,
      );
    }
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw new StreamRefusalError(
        503,
        code,
        error instanceof Error ? error.message : `Worker ${workerId} could not be reached`,
      );
    }
    throw error;
  }
}

// why: a refusal body is read only far enough to find its code and message; a worker that answered
// with megabytes must not make the gateway buffer them.
const MAX_REFUSAL_BYTES = 16 * 1024;

async function fromResponse(
  workerId: string,
  subject: string,
  response: Response,
): Promise<CapturedStream> {
  // why: the codec header is what tells a relayed stream from a relayed refusal -- a gateway reads a
  // stream's headers and never one video byte, which is also why a refusal is read as JSON here and a
  // picture never is.
  const codec = response.headers.get("simlock-stream-codec");
  if (!response.ok || codec === null || response.body === null) {
    const reason = await readCapped(response, MAX_REFUSAL_BYTES);
    throw relayedRefusal(workerId, subject, response.status, reason);
  }
  let meta: ScreenMeta;
  try {
    meta = checkedMeta(
      codec,
      numberHeader(response, "simlock-stream-width"),
      numberHeader(response, "simlock-stream-height"),
      numberHeader(response, "simlock-stream-fps"),
    );
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw streamUnavailable(
      `Worker ${workerId} answered the stream for ${subject} with a picture it cannot describe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const body = response.body;
  return {
    body,
    // why: a browser that goes away aborts its request, which aborts the relay, which the worker
    // answers by stopping its own capture -- so this covers only a gateway that gives up by itself.
    close: async () => {
      await body.cancel().catch(() => undefined);
    },
    meta,
  };
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      size += step.value.length;
    }
  } catch {
    // why: a refusal whose body broke is still a refusal; its status says enough.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, joined.length - offset);
    joined.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(joined);
}

function numberHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  return raw === null || raw.trim() === "" ? undefined : Number(raw);
}
