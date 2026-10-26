import type { CapturedStream } from "./feed.js";
import type { StreamCaller } from "./caller.js";
import { noSuchStream, StreamRefusalError } from "./refusal.js";

// why: a stream is asked for by the device it films; `workerId` is absent on the relay door, where the
// gateway has already chosen the worker.
export type StreamTarget = DeviceStreamTarget | LeaseStreamTarget;

export interface DeviceStreamTarget {
  readonly deviceId: string;
  readonly workerId?: string;
  readonly leaseId?: undefined;
  readonly workerLeaseId?: undefined;
}

// why: a lease's stream is asked for by the lease; the caller's right to it was settled by the HTTP
// layer's lease lookup, so a link never checks an owner. `workerLeaseId` is the worker's own id for a
// lease a gateway names by its own.
export interface LeaseStreamTarget {
  readonly leaseId: string;
  readonly workerId?: string;
  readonly workerLeaseId?: string;
  readonly deviceId?: undefined;
}

export interface StreamLink {
  serve(target: StreamTarget, caller: StreamCaller, signal: AbortSignal): Promise<CapturedStream>;
}

export interface StreamServiceOptions {
  readonly link: StreamLink;
  readonly logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function streamTargetOf(pathname: string): StreamTarget | undefined {
  const device = /^\/v1\/stream\/workers\/([^/]+)\/devices\/([^/]+)$/.exec(pathname);
  if (device?.[1] === undefined || device[2] === undefined) return undefined;
  const workerId = decoded(device[1]);
  const deviceId = decoded(device[2]);
  return workerId === undefined || deviceId === undefined ? undefined : { deviceId, workerId };
}

export function relayedDeviceTargetOf(pathname: string): StreamTarget | undefined {
  const encoded = /^\/stream\/devices\/([^/]+)$/.exec(pathname)?.[1];
  const deviceId = encoded === undefined ? undefined : decoded(encoded);
  return deviceId === undefined ? undefined : { deviceId };
}

export function relayedLeaseTargetOf(pathname: string): StreamTarget | undefined {
  const encoded = /^\/stream\/leases\/([^/]+)$/.exec(pathname)?.[1];
  const leaseId = encoded === undefined ? undefined : decoded(encoded);
  return leaseId === undefined ? undefined : { leaseId };
}

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export async function handleStreamRequest(
  options: StreamServiceOptions,
  request: Request,
  caller: StreamCaller,
  target: StreamTarget | undefined,
): Promise<Response> {
  if (target === undefined) return refusalResponse(noSuchStream());
  if (request.method !== "GET") {
    // why: 405 rather than a 404 for a path that does exist -- a caller that posted to a stream is one
    // command away from the right ask, and "no such thing" would send it looking elsewhere.
    return refusalResponse(
      new StreamRefusalError(405, "BAD_REQUEST", "A stream is read, not written"),
    );
  }

  let stream: CapturedStream;
  try {
    stream = await options.link.serve(target, caller, request.signal);
  } catch (error) {
    const refusal =
      error instanceof StreamRefusalError
        ? error
        : new StreamRefusalError(
            500,
            "INTERNAL",
            error instanceof Error ? error.message : String(error),
          );
    options.logger?.warn("Screen stream refused", {
      ...targetFields(target),
      code: refusal.code,
      message: refusal.message,
    });
    return refusalResponse(refusal);
  }

  options.logger?.info("Screen stream opened", {
    codec: stream.meta.codec,
    height: stream.meta.height,
    ...targetFields(target),
    width: stream.meta.width,
  });
  return streamResponse(stream);
}

export function streamResponse(stream: CapturedStream): Response {
  const { meta } = stream;
  // why: the codec and size are headers as well as the body's first frame, because a browser must
  // decide how to read a body before it has read any of it, and because a gateway reads the headers
  // instead of the body -- which is what lets it relay video without touching a video byte.
  return new Response(stream.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": `application/vnd.simlock.stream+${meta.codec}`,
      "simlock-stream-codec": meta.codec,
      "simlock-stream-fps": String(meta.fps),
      "simlock-stream-height": String(meta.height),
      "simlock-stream-width": String(meta.width),
    },
    status: 200,
  });
}

function targetFields(target: StreamTarget): Record<string, unknown> {
  return { deviceId: target.deviceId, leaseId: target.leaseId, workerId: target.workerId };
}

// why: one body shape for every refusal this route can make -- `{ "error": { "code", "message" } }`,
// the shape every other route answers with -- so a client that reads `error.code` needs no special
// case for a stream that never started, and a gateway can forward a worker's code unchanged.
function refusalResponse(refusal: StreamRefusalError): Response {
  return json(refusal.status, { error: { code: refusal.code, message: refusal.message } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
