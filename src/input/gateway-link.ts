import { closeReason, MAX_INPUT_MESSAGE_BYTES } from "../core/index.js";
import type {
  FleetLeases,
  ModuleIdentity,
  ModuleLease,
  ModuleLeaseSocketAccept,
  ModuleTwoWayRelay,
} from "../modules/index.js";
import type { Clock, LeaseSocket, TimerHandle } from "../ports/index.js";
import { CHANNEL_TAG, encodeFrame, readFrames } from "./framing.js";
import { unavailable } from "./refusal.js";

export interface GatewayInputLinkOptions {
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

// why: the relay's own head deadline is 330 s, far too long for a person waiting on a socket; the
// socket's open is bounded here and aborts the relay's open when it runs out.
const OPEN_BOUND_MS = 10_000;

// why: the worker's `0xF1` usually follows the relayed lease event, and it carries the reason; the gateway
// waits this long for it before closing a socket whose lease it saw go.
const LEASE_END_WAIT_MS = 2_000;

export function createGatewayInputLink(options: GatewayInputLinkOptions): {
  open(
    request: Request,
    identity: ModuleIdentity,
    lease: ModuleLease,
  ): Promise<Response | ModuleLeaseSocketAccept>;
  drain(): void;
} {
  const bridges = new Map<string, Set<Bridge>>();
  options.leases.onRemoved((entry) => {
    for (const bridge of bridges.get(entry.gatewayLeaseId) ?? []) bridge.leaseGone();
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
    function stopped(): void {
      stop(1011, `Worker ${lease.workerId ?? ""} stopped answering`);
    }
    function stop(code: number, reason: string): void {
      if (ended) return;
      ended = true;
      if (wait !== undefined) options.clock.cancel(wait);
      set.delete(mine);
      if (set.size === 0) bridges.delete(lease.id);
      socket.close(code, closeReason(reason));
      controller.abort();
    }
    socket.onMessage((data) => {
      // why: a frame over the limit would end the channel for everyone on the lease, and a message that long is dropped on every door.
      if (data.length > MAX_INPUT_MESSAGE_BYTES) return;
      const frame = encodeFrame(data[0] ?? 0, data.subarray(1));
      writes = writes.then(() => writer.write(frame)).catch(() => undefined);
    });
    socket.onClose(() => {
      ended = true;
      if (wait !== undefined) options.clock.cancel(wait);
      set.delete(mine);
      controller.abort();
    });
    void (async () => {
      for await (const frame of readFrames(relay.readable)) {
        if (frame.tag === CHANNEL_TAG.close) {
          const closing = closeOf(frame.payload);
          // why: a worker that is stopping says 1001, which is a statement about the gateway to a client; to the client the worker is gone.
          if (closing === undefined || closing.code === 1001) stopped();
          else stop(closing.code, closing.reason);
          return;
        }
        if (frame.tag === CHANNEL_TAG.heartbeat) continue;
        const message = new Uint8Array(1 + frame.payload.length);
        message[0] = frame.tag;
        message.set(frame.payload, 1);
        socket.send(message);
      }
      // why: the worker's direction ended with no close frame, or broke: it is gone, and the relay's own silence limit and an uplink that dropped end up here too.
      stopped();
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
          new Request(`http://simlock-worker/input/leases/${encodeURIComponent(lease.id)}`, {
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
            `Worker ${workerId} did not answer the input socket within 10 s`,
          );
        }
        return refusalFor(error, workerId, lease.id);
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

// why: the relay fails with the fleet's own codes -- a worker that takes no input (`RELAY_TARGET_MISSING`),
// a worker gone (`WORKER_UNREACHABLE`) -- and a client must get a 503 that says which, before the upgrade;
// an error with no code is a real fault and goes on to the HTTP layer's 500.
function refusalFor(error: unknown, workerId: string, leaseId: string): Response {
  const code = (error as { readonly code?: unknown }).code;
  if (code === "RELAY_TARGET_MISSING") {
    return unavailable(
      "INPUT_UNAVAILABLE",
      `Worker ${workerId} does not take input for lease ${leaseId}; turn on capabilities.input.enabled there`,
    );
  }
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    return unavailable(
      code,
      error instanceof Error ? error.message : `Worker ${workerId} could not be reached`,
    );
  }
  throw error;
}

interface Bridge {
  readonly leaseGone: () => void;
  readonly stop: (code: number, reason: string) => void;
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
