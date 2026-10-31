import {
  CHANNEL_TAG,
  closeOf,
  encodeFrame,
  type FleetLeases,
  type ModuleIdentity,
  type ModuleLease,
  type ModuleLeaseSocketAccept,
  type ModuleTwoWayRelay,
  readFrames,
  relayRefusal,
  unavailable,
} from "../modules/index.js";
import type { Clock, LeaseSocket, TimerHandle } from "../ports/index.js";
import { encodeTunnelFrame, TUNNEL_REFUSED_CLOSE, TUNNEL_TAG } from "../contract/index.js";
import { closeReason } from "../core/index.js";
import { MAX_TUNNEL_MESSAGE_BYTES } from "./limits.js";

export interface GatewayTunnelLinkOptions {
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

interface Bridge {
  readonly leaseGone: () => void;
  readonly stop: (code: number, reason: string) => void;
}

export function createGatewayTunnelLink(options: GatewayTunnelLinkOptions): {
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
      if (data.length > MAX_TUNNEL_MESSAGE_BYTES) {
        // why: a frame over the limit would break the channel for the whole lease, so the gateway refuses it as the worker refuses a bad frame.
        const message = `a frame is longer than ${String(MAX_TUNNEL_MESSAGE_BYTES)} bytes`;
        socket.send(
          encodeTunnelFrame(
            TUNNEL_TAG.refused,
            0,
            JSON.stringify({ code: "BAD_REQUEST", message }),
          ),
        );
        stop(TUNNEL_REFUSED_CLOSE, message);
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
      for await (const frame of readFrames(relay.readable, MAX_TUNNEL_MESSAGE_BYTES)) {
        if (frame.tag === CHANNEL_TAG.close) {
          const closing = closeOf(frame.payload);
          // why: a worker that is stopping says 1001, which is a statement about the gateway to a holder; to the holder the worker is gone.
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
          new Request(`http://simlock-worker/tunnel/leases/${encodeURIComponent(lease.id)}`, {
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
            `Worker ${workerId} did not answer the tunnel socket within 10 s`,
          );
        }
        return relayRefusal(error, workerId, {
          code: "TUNNEL_UNAVAILABLE",
          message: `Tunnels are off on worker ${workerId}; turn on capabilities.tunnel.enabled there`,
        });
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
