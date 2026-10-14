// why: a stream refuses for reasons a link knows and the HTTP layer must not guess at, and every
// other route in this API answers `{ "error": { "code", "message" } }`. A link that throws one of
// these instead of a plain Error is what lets the mount keep that shape and lets a gateway forward
// the worker's own code rather than rewriting it into prose a viewer has to read.
export class StreamRefusalError extends Error {
  // why: `code` is a free string rather than a closed union, because a gateway forwards the code its
  // worker answered with and that worker may be a build this one has never seen. The codes this
  // service raises itself are `UNKNOWN_LEASE`, `BAD_REQUEST`, `STREAM_NOT_SUPPORTED`,
  // `STREAM_UNAVAILABLE` and `INTERNAL`, and `docs/HTTP-API.md` is where they are promised.
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StreamRefusalError";
  }
}

export function unknownLease(leaseId: string): StreamRefusalError {
  return new StreamRefusalError(404, "UNKNOWN_LEASE", `Unknown lease: ${leaseId}`);
}

export function noSuchStream(): StreamRefusalError {
  // why: the same status and code as an unknown lease on purpose -- a daemon with `stream.enabled` off
  // never mounts this route at all and answers any path it has not heard of as a 404, so a client that
  // could tell these apart would be able to learn which daemons can stream by asking one.
  return new StreamRefusalError(404, "UNKNOWN_LEASE", "This path names no stream lease");
}

export function notStreamable(message: string): StreamRefusalError {
  return new StreamRefusalError(415, "STREAM_NOT_SUPPORTED", message);
}

export function streamUnavailable(message: string): StreamRefusalError {
  return new StreamRefusalError(503, "STREAM_UNAVAILABLE", message);
}

export function relayedRefusal(
  workerId: string,
  leaseId: string,
  status: number,
  body: string,
): StreamRefusalError {
  const error = asRecord(parse(body))?.["error"];
  const fields = asRecord(error);
  const message = fields?.["message"];
  if (typeof message === "string" && message !== "") {
    const code = fields?.["code"];
    return new StreamRefusalError(
      status,
      typeof code === "string" ? code : "STREAM_UNAVAILABLE",
      message,
    );
  }
  // why: a body that will not parse is still a refusal, and its status is the part that is certain --
  // but a worker that answered 200 with no picture has broken the one promise a stream makes, which is
  // this gateway's own failure to deliver, not the worker refusing.
  return new StreamRefusalError(
    status >= 200 && status < 300 ? 502 : status,
    "STREAM_UNAVAILABLE",
    `Worker ${workerId} refused the stream for lease ${leaseId}${body === "" ? "" : `: ${body}`}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
