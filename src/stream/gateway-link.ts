import type { ScreenMeta } from "../core/index.js";
import { type Broadcast, createBroadcast } from "./broadcast.js";
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
import {
  KEYFRAME_HEADER,
  KEYFRAME_PROMISE_MS,
  type StreamLink,
  type StreamTarget,
} from "./service.js";

export interface FleetPort {
  knowsWorker(workerId: string): boolean;
  // why: `gw:<this gateway's instance id>:`, the exact prefix this index recognizes a requester it
  // sent by, so a stream namespaces with the same value its leases do.
  readonly requesterPrefix: string;
  relay(
    workerId: string,
    call: {
      readonly request: Request;
      readonly tenant: string;
      readonly leaseId?: string | undefined;
    },
  ): Promise<Response>;
}

export interface GatewayStreamLinkOptions {
  readonly fleet: FleetPort;
}

export function createGatewayStreamLink(options: GatewayStreamLinkOptions): StreamLink {
  const relays = new Map<string, SharedRelay>();
  return {
    serve: (target, caller, signal) => serveDevice(options, relays, target, caller, signal),
  };
}

interface Waiter {
  readonly target: StreamTarget;
  readonly caller: StreamCaller;
  readonly signal: AbortSignal;
  readonly resolve: (stream: CapturedStream) => void;
  readonly reject: (error: unknown) => void;
}

// why: a shared relay belongs to the gateway, not to the viewer that opened it: its own abort controller
// ends it, once its last viewer has left.
interface SharedRelay {
  readonly controller: AbortController;
  readonly waiters: Set<Waiter>;
  broadcast: Broadcast | undefined;
}

async function serveDevice(
  options: GatewayStreamLinkOptions,
  relays: Map<string, SharedRelay>,
  target: StreamTarget,
  caller: StreamCaller,
  signal: AbortSignal,
): Promise<CapturedStream> {
  // why: the same refusal an unknown device gets, before any relay, so an agent cannot reach a screen
  // by naming a device. A lease's stream was checked against its owner by the HTTP layer.
  if (target.leaseId === undefined && caller.role !== "operator") {
    throw unknownDevice(target.deviceId);
  }
  const workerId = target.workerId ?? "";
  if (!options.fleet.knowsWorker(workerId)) throw unknownWorker(workerId);
  // why: a lease is shared by the worker's own id for it, and a device by its id; the two never share,
  // because the gateway does not know a lease's device before the worker answers.
  const key = `${workerId}\u0000${
    target.leaseId === undefined
      ? `device:${target.deviceId}`
      : `lease:${target.workerLeaseId ?? target.leaseId}`
  }`;
  const existing = relays.get(key);
  if (existing?.broadcast !== undefined && !existing.broadcast.stopped) {
    return existing.broadcast.join(signal);
  }
  if (existing !== undefined && existing.broadcast === undefined) {
    return waitFor(existing, { caller, signal, target });
  }
  const entry: SharedRelay = {
    broadcast: undefined,
    controller: new AbortController(),
    waiters: new Set(),
  };
  relays.set(key, entry);
  const stream = waitFor(entry, { caller, signal, target });
  void openShared(options, relays, key, entry, workerId, target, caller);
  return stream;
}

function waitFor(
  entry: SharedRelay,
  viewer: Pick<Waiter, "caller" | "signal" | "target">,
): Promise<CapturedStream> {
  return new Promise<CapturedStream>((resolve, reject) => {
    const waiter: Waiter = { ...viewer, reject, resolve };
    entry.waiters.add(waiter);
    const leave = () => {
      if (!entry.waiters.delete(waiter)) return;
      reject(viewer.signal.reason);
      if (entry.waiters.size === 0) entry.controller.abort();
    };
    if (viewer.signal.aborted) leave();
    else viewer.signal.addEventListener("abort", leave, { once: true });
  });
}

async function openShared(
  options: GatewayStreamLinkOptions,
  relays: Map<string, SharedRelay>,
  key: string,
  entry: SharedRelay,
  workerId: string,
  target: StreamTarget,
  opener: StreamCaller,
): Promise<void> {
  const subject = subjectOf(target);
  let response: Response;
  let captured: CapturedStream;
  try {
    response = await relayed(workerId, subject, () =>
      callRelay(options, workerId, target, opener, entry.controller.signal),
    );
    captured = await fromResponse(workerId, subject, response);
  } catch (error) {
    if (relays.get(key) === entry) relays.delete(key);
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) waiter.reject(withCallersLeaseId(waiter.target, error));
    return;
  }
  const waiters = [...entry.waiters];
  entry.waiters.clear();
  if (waiters.length === 0) {
    if (relays.get(key) === entry) relays.delete(key);
    await captured.close();
    return;
  }
  if (response.headers.get(KEYFRAME_HEADER) === String(KEYFRAME_PROMISE_MS)) {
    const broadcast = createBroadcast(captured);
    entry.broadcast = broadcast;
    void broadcast.done.then(() => {
      entry.controller.abort();
      if (relays.get(key) === entry) relays.delete(key);
    });
    for (const waiter of waiters) waiter.resolve(broadcast.join(waiter.signal));
    return;
  }
  // why: a worker that makes no promise cannot start a joiner, so its first viewer takes this relay as its
  // own -- its leaving ends it -- and each other viewer asks for one of its own, as before sharing.
  if (relays.get(key) === entry) relays.delete(key);
  const [taker, ...others] = waiters;
  if (taker === undefined) return;
  taker.signal.addEventListener("abort", () => entry.controller.abort(), { once: true });
  if (taker.signal.aborted) entry.controller.abort();
  taker.resolve(captured);
  for (const other of others) {
    serveAlone(options, workerId, other.target, other.caller, other.signal).then(
      other.resolve,
      other.reject,
    );
  }
}

async function serveAlone(
  options: GatewayStreamLinkOptions,
  workerId: string,
  target: StreamTarget,
  caller: StreamCaller,
  signal: AbortSignal,
): Promise<CapturedStream> {
  const subject = subjectOf(target);
  const response = await relayed(workerId, subject, () =>
    callRelay(options, workerId, target, caller, signal),
  );
  try {
    return await fromResponse(workerId, subject, response);
  } catch (error) {
    throw withCallersLeaseId(target, error);
  }
}

function subjectOf(target: StreamTarget): string {
  return target.leaseId === undefined ? `device ${target.deviceId}` : `lease ${target.leaseId}`;
}

function callRelay(
  options: GatewayStreamLinkOptions,
  workerId: string,
  target: StreamTarget,
  caller: StreamCaller,
  signal: AbortSignal,
): Promise<Response> {
  return options.fleet.relay(workerId, {
    leaseId: target.workerLeaseId,
    request: new Request(`http://simlock-worker${relayPath(target)}`, { method: "GET", signal }),
    tenant: `${options.fleet.requesterPrefix}${caller.principal}`,
  });
}

function relayPath(target: StreamTarget): string {
  return target.leaseId === undefined
    ? `/stream/devices/${encodeURIComponent(target.deviceId)}`
    : `/stream/leases/${encodeURIComponent(target.workerLeaseId ?? target.leaseId)}`;
}

// why: the worker names the lease by its own id, which the caller never saw; the gateway puts back
// the id the caller asked for.
function withCallersLeaseId(target: StreamTarget, error: unknown): unknown {
  if (
    target.leaseId !== undefined &&
    error instanceof StreamRefusalError &&
    error.status === 404 &&
    error.code === "UNKNOWN_LEASE"
  ) {
    return unknownLease(target.leaseId);
  }
  return error;
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
