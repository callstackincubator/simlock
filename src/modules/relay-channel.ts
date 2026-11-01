// why: a module that goes through a gateway's two-way relay (input, tunnel) frames the channel, maps its close and refuses an
// upgrade the same way; one copy here keeps them from drifting. The module decides what a frame means and how long one may be.
import type { Clock, LeaseSocket, TimerHandle } from "../ports/index.js";
import { closeReason } from "../core/index.js";
import type {
  FleetLeases,
  ModuleIdentity,
  ModuleLease,
  ModuleLeaseSocketAccept,
  ModuleTwoWayPipe,
  ModuleTwoWayRelay,
} from "./types.js";

// why: the two channel-only tags: a heartbeat the worker sends while it is alive, and the worker's close
// `{code, reason}`; neither reaches a client, and a client's tags are the module's own.
const CHANNEL_TAG = { close: 0xf1, heartbeat: 0xf0 } as const;

const HEARTBEAT_MS = 5_000;

interface ChannelFrame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

// why: the channel framing of a two-way relay (ADR 0049 section 5): `[len u32 big-endian][tag u8][payload]`, `len` counting the tag and the payload.
function encodeFrame(tag: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1);
  frame[4] = tag;
  frame.set(payload, 5);
  return frame;
}

function joined(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const all = new Uint8Array(head.length + tail.length);
  all.set(head);
  all.set(tail, head.length);
  return all;
}

// why: ends quietly on a frame whose `len` is over `maxLength`, a stream that ends mid-frame and a stream
// that errors, so a peer that breaks the framing or drops is the same as one that went away.
async function* readFrames(
  readable: ReadableStream<Uint8Array>,
  maxLength: number,
): AsyncGenerator<ChannelFrame, void, void> {
  const reader = readable.getReader();
  let buffer: Uint8Array = new Uint8Array();
  try {
    for (;;) {
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.length).getUint32(0);
        if (length < 1 || length > maxLength) return;
        if (buffer.length < 4 + length) break;
        yield { payload: buffer.slice(5, 4 + length), tag: buffer[4] ?? 0 };
        buffer = buffer.subarray(4 + length);
      }
      const step = await reader.read().catch(() => undefined);
      if (step === undefined || step.done) return;
      buffer = joined(buffer, step.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

// why: a worker's session talks to a gateway's client through a relay channel, and the session takes a
// `LeaseSocket` whichever door the client came in by; this is the channel's end of that port, a socket
// whose messages are frames of the channel, each at most `maxLength` by `readFrames`.
export function channelSocket(
  pipe: ModuleTwoWayPipe,
  clock: Clock,
  maxLength: number,
): LeaseSocket {
  const writer = pipe.writable.getWriter();
  const messageListeners: ((data: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;
  let beat: TimerHandle | undefined;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    if (beat !== undefined) clock.cancel(beat);
    for (const listener of closeListeners) listener();
  };
  const write = (frame: Uint8Array): void => {
    writes = writes.then(() => writer.write(frame)).catch(() => undefined);
  };
  // why: the gateway ends a relay whose worker direction is silent for 15 s, and a session with nothing to say still has to be seen alive.
  const heartbeat = (): void => {
    write(encodeFrame(CHANNEL_TAG.heartbeat, new Uint8Array()));
    beat = clock.setTimer(HEARTBEAT_MS, heartbeat);
  };
  beat = clock.setTimer(HEARTBEAT_MS, heartbeat);
  void (async () => {
    for await (const frame of readFrames(pipe.readable, maxLength)) {
      const message = new Uint8Array(1 + frame.payload.length);
      message[0] = frame.tag;
      message.set(frame.payload, 1);
      for (const listener of messageListeners) listener(message);
    }
    markClosed();
  })();
  pipe.signal.addEventListener("abort", markClosed, { once: true });
  return {
    close: (code, reason) => {
      write(
        encodeFrame(CHANNEL_TAG.close, new TextEncoder().encode(JSON.stringify({ code, reason }))),
      );
      writes = writes.then(() => writer.close()).catch(() => undefined);
      markClosed();
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
    },
    send: (data) => write(encodeFrame(data[0] ?? 0, data.subarray(1))),
  };
}

// why: the worker's close is wire input from another process: a code and a reason a socket may close with, or nothing.
function closeOf(payload: Uint8Array): { code: number; reason: string } | undefined {
  try {
    const { code, reason } = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >;
    if (typeof code !== "number" || !Number.isInteger(code)) return undefined;
    if (code !== 1001 && code !== 1013 && (code < 4000 || code > 4999)) return undefined;
    return typeof reason === "string" ? { code, reason: closeReason(reason) } : undefined;
  } catch {
    return undefined;
  }
}

function refusal(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

// why: a plain GET to the socket's path says what the path is for, so a person who opens it in a browser knows to open a socket.
export function upgradeRequired(): Response {
  return refusal(426, "BAD_REQUEST", "This path takes a WebSocket upgrade, not a plain request", {
    upgrade: "websocket",
  });
}

export function unknownLease(leaseId: string): Response {
  return refusal(404, "UNKNOWN_LEASE", `Unknown lease: ${leaseId}`);
}

// why: the relay fails with the fleet's own codes -- a worker without the module (`RELAY_TARGET_MISSING`, answered
// with the module's `missing` code and text), a worker gone (`WORKER_UNREACHABLE`) -- and a client must get a 503 that says
// which, before the upgrade; an error with no code is a real fault and goes on to the HTTP layer's 500.
function relayRefusal(
  error: unknown,
  workerId: string,
  missing: { readonly code: string; readonly message: string },
): Response {
  const code = (error as { readonly code?: unknown }).code;
  if (code === "RELAY_TARGET_MISSING") return refusal(503, missing.code, missing.message);
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    return refusal(
      503,
      code,
      error instanceof Error ? error.message : `Worker ${workerId} could not be reached`,
    );
  }
  throw error;
}

function unavailable(code: string, message: string): Response {
  return refusal(503, code, message);
}

export interface GatewayChannelLinkOptions {
  readonly relayTwoWay: (
    workerId: string,
    request: Request,
    tenant: string,
    leaseId?: string,
  ) => Promise<Response | ModuleTwoWayRelay>;
  readonly requesterPrefix: string;
  readonly clock: Clock;
  readonly leases: FleetLeases;
}

// why: what differs between the modules that bridge a client socket to a worker's channel: the worker's path, the
// frame bounds and what a client frame over the bound does, and the texts of the two 503s before the upgrade.
export interface GatewayChannelShape {
  // why: the worker's path for a lease, e.g. `/input/leases`; the lease id is appended.
  readonly path: string;
  // why: the name in "did not answer the <socketName> within 10 s".
  readonly socketName: string;
  // why: the longest channel frame the worker may send, passed to `readFrames`.
  readonly readLimit: number;
  // why: a client message longer than `limit` is dropped, or with `refuse` is answered with that frame and a close.
  readonly oversize: {
    readonly limit: number;
    readonly refuse?: {
      readonly frame: Uint8Array;
      readonly code: number;
      readonly reason: string;
    };
  };
  readonly missing: (workerId: string, lease: ModuleLease) => { code: string; message: string };
}

interface Bridge {
  readonly leaseGone: () => void;
  readonly stop: (code: number, reason: string) => void;
}

// why: the relay's own head deadline is 330 s, far too long for a person waiting on a socket; the
// socket's open is bounded here and aborts the relay's open when it runs out.
const OPEN_BOUND_MS = 10_000;

// why: the worker's `0xF1` usually follows the relayed lease event, and it carries the reason; the gateway
// waits this long for it before closing a socket whose lease it saw go.
const LEASE_END_WAIT_MS = 2_000;

// why: input and tunnel bridge a gateway client's socket to a worker's channel the same way; one copy keeps the open
// bound, the lease-end wait and the worker-gone mapping from drifting.
export function createGatewayChannelLink(
  options: GatewayChannelLinkOptions,
  shape: GatewayChannelShape,
): {
  open(
    request: Request,
    identity: ModuleIdentity,
    lease: ModuleLease,
  ): Promise<Response | ModuleLeaseSocketAccept>;
  drain(): void;
} {
  const bridges = new Map<string, Set<Bridge>>();
  options.leases.onRemoved((entry) => {
    for (const each of bridges.get(entry.gatewayLeaseId) ?? []) each.leaseGone();
  });

  function bridge(
    socket: LeaseSocket,
    relay: ModuleTwoWayRelay,
    controller: AbortController,
    lease: ModuleLease,
  ): void {
    const writer = relay.writable.getWriter();
    let writes: Promise<unknown> = Promise.resolve();
    let ended = false;
    let wait: TimerHandle | undefined;
    const mine: Bridge = {
      leaseGone: () => {
        wait ??= options.clock.setTimer(LEASE_END_WAIT_MS, () => stop(4001, "lease ended"));
      },
      stop: (code, reason) => stop(code, reason),
    };
    const set = bridges.get(lease.id) ?? new Set<Bridge>();
    set.add(mine);
    bridges.set(lease.id, set);
    function forget(): void {
      ended = true;
      if (wait !== undefined) options.clock.cancel(wait);
      set.delete(mine);
      if (set.size === 0) bridges.delete(lease.id);
    }
    function stop(code: number, reason: string): void {
      if (ended) return;
      forget();
      socket.close(code, closeReason(reason));
      controller.abort();
    }
    socket.onMessage((data) => {
      if (data.length > shape.oversize.limit) {
        const refuse = shape.oversize.refuse;
        if (refuse !== undefined) {
          socket.send(refuse.frame);
          stop(refuse.code, refuse.reason);
        }
        return;
      }
      const frame = encodeFrame(data[0] ?? 0, data.subarray(1));
      writes = writes.then(() => writer.write(frame)).catch(() => undefined);
    });
    socket.onClose(() => {
      forget();
      controller.abort();
    });
    void (async () => {
      for await (const frame of readFrames(relay.readable, shape.readLimit)) {
        if (frame.tag === CHANNEL_TAG.close) {
          const closing = closeOf(frame.payload);
          // why: a worker that is stopping says 1001, which is a statement about the gateway to a client; to the client the worker is gone.
          if (closing === undefined || closing.code === 1001) break;
          stop(closing.code, closing.reason);
          return;
        }
        if (frame.tag === CHANNEL_TAG.heartbeat) continue;
        const message = new Uint8Array(1 + frame.payload.length);
        message[0] = frame.tag;
        message.set(frame.payload, 1);
        socket.send(message);
      }
      // why: the worker's direction ended with no close frame, or broke: it is gone, and the relay's own silence limit and an uplink that dropped end up here too.
      stop(1011, `Worker ${lease.workerId ?? ""} stopped answering`);
    })();
  }

  return {
    drain: () => {
      for (const set of bridges.values()) {
        for (const each of set) each.stop(1001, "Simlock is stopping");
      }
    },
    open: async (_request, identity, lease) => {
      const controller = new AbortController();
      const workerId = lease.workerId ?? "";
      let relay: Response | ModuleTwoWayRelay;
      let timedOut = false;
      const timer = options.clock.setTimer(OPEN_BOUND_MS, () => {
        timedOut = true;
        controller.abort();
      });
      try {
        relay = await options.relayTwoWay(
          workerId,
          new Request(`http://simlock-worker${shape.path}/${encodeURIComponent(lease.id)}`, {
            method: "GET",
            signal: controller.signal,
          }),
          `${options.requesterPrefix}${identity.principal}`,
          lease.workerLeaseId,
        );
      } catch (error) {
        if (timedOut) {
          return unavailable(
            "WORKER_UNREACHABLE",
            `Worker ${workerId} did not answer the ${shape.socketName} within 10 s`,
          );
        }
        return relayRefusal(error, workerId, shape.missing(workerId, lease));
      } finally {
        options.clock.cancel(timer);
      }
      if (relay instanceof Response) return relay;
      return Object.assign((socket: LeaseSocket) => bridge(socket, relay, controller, lease), {
        abandon: () => controller.abort(),
      });
    },
  };
}
