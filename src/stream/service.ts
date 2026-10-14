import type { CapturedStream } from "./capture.js";
import type { StreamCaller } from "./caller.js";
import { noSuchStream, StreamRefusalError } from "./refusal.js";

export interface StreamLink {
  serve(leaseId: string, caller: StreamCaller, signal: AbortSignal): Promise<CapturedStream>;
}

export interface StreamServiceOptions {
  readonly link: StreamLink;
  readonly logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export const STREAM_PREFIX = "stream";

export function leaseIdOf(pathname: string): string | undefined {
  const match = /^\/v1\/stream\/leases\/([^/]+)$/.exec(pathname);
  const encoded = match?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export async function handleStreamRequest(
  options: StreamServiceOptions,
  request: Request,
  caller: StreamCaller,
  leaseId: string | undefined,
): Promise<Response> {
  if (leaseId === undefined) return refusalResponse(noSuchStream());
  if (request.method !== "GET") {
    // why: 405 rather than a 404 for a path that does exist -- a caller that posted to a stream is one
    // command away from the right ask, and "no such thing" would send it looking elsewhere.
    return refusalResponse(
      new StreamRefusalError(405, "BAD_REQUEST", "A stream is read, not written"),
    );
  }

  let stream: CapturedStream;
  try {
    stream = await options.link.serve(leaseId, caller, request.signal);
  } catch (error) {
    const refusal =
      error instanceof StreamRefusalError
        ? error
        : new StreamRefusalError(500, "INTERNAL", error instanceof Error ? error.message : String(error));
    options.logger?.warn("Screen stream refused", {
      code: refusal.code,
      leaseId,
      message: refusal.message,
    });
    return refusalResponse(refusal);
  }

  options.logger?.info("Screen stream opened", {
    codec: stream.meta.codec,
    height: stream.meta.height,
    leaseId,
    width: stream.meta.width,
  });
  return streamResponse(leaseId, stream);
}

export function streamResponse(leaseId: string, stream: CapturedStream): Response {
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
      "x-simlock-lease": leaseId,
    },
    status: 200,
  });
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
