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
  // why: the same status and code as an unknown lease on purpose -- a daemon with `capabilities.stream.enabled` off
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

// why: a worker's refusal is a claim, and it reaches a viewer's screen and this gateway's log; a code
// that is not one of ours in shape, or a message past this length, is not forwarded as the worker's.
const RELAYED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_RELAYED_MESSAGE = 1_000;

export function relayedRefusal(
  workerId: string,
  leaseId: string,
  status: number,
  body: string,
): StreamRefusalError {
  const fields = asRecord(asRecord(parse(body))?.["error"]);
  const code = fields?.["code"];
  const message = fields?.["message"];
  // why: a worker that answered 2xx with no picture has broken the one promise a stream makes, which
  // is this gateway's failure to deliver, not the worker refusing; any other status is the worker's.
  const relayedStatus = status >= 400 && status <= 599 ? status : 502;
  if (
    typeof code === "string" &&
    RELAYED_CODE.test(code) &&
    typeof message === "string" &&
    message !== ""
  ) {
    return new StreamRefusalError(relayedStatus, code, message.slice(0, MAX_RELAYED_MESSAGE));
  }
  return new StreamRefusalError(
    relayedStatus,
    "STREAM_UNAVAILABLE",
    `Worker ${workerId} refused the stream for lease ${leaseId} with status ${String(status)}`,
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
