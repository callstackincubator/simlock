import type {
  ModuleIdentity,
  ModuleLease,
  ModuleLeaseSocketAccept,
  ModuleTwoWayRelay,
} from "../modules/index.js";
import type { LeaseSocket } from "../ports/index.js";
import { unavailable } from "./refusal.js";
import { closeReason } from "../core/index.js";
import { CHANNEL_TAG, encodeFrame, MAX_TUNNEL_MESSAGE_BYTES, readFrames } from "./framing.js";

export interface GatewayTunnelLinkOptions {
  readonly relayTwoWay: (
    workerId: string,
    request: Request,
    tenant: string,
    leaseId?: string,
  ) => Promise<Response | ModuleTwoWayRelay>;
  readonly requesterPrefix: string;
}

// why: a worker with tunnels off has no relay target, and a holder must get a 503 that says to turn the capability on there, before the upgrade; an error with no such code is a real fault and goes on to the HTTP layer's 500.
function refusalFor(error: unknown, workerId: string): Response {
  if ((error as { readonly code?: unknown }).code === "RELAY_TARGET_MISSING") {
    return unavailable(
      "TUNNEL_UNAVAILABLE",
      `Tunnels are off on worker ${workerId}; turn on capabilities.tunnel.enabled there`,
    );
  }
  throw error;
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

export function createGatewayTunnelLink(options: GatewayTunnelLinkOptions): {
  open(
    request: Request,
    identity: ModuleIdentity,
    lease: ModuleLease,
  ): Promise<Response | ModuleLeaseSocketAccept>;
} {
  function bridge(
    socket: LeaseSocket,
    relay: ModuleTwoWayRelay,
    controller: AbortController,
    lease: ModuleLease,
  ): void {
    const writer = relay.writable.getWriter();
    let writes: Promise<unknown> = Promise.resolve();
    socket.onMessage((data) => {
      if (data.length > MAX_TUNNEL_MESSAGE_BYTES) return;
      const frame = encodeFrame(data[0] ?? 0, data.subarray(1));
      writes = writes.then(() => writer.write(frame)).catch(() => undefined);
    });
    socket.onClose(() => controller.abort());
    void (async () => {
      for await (const frame of readFrames(relay.readable)) {
        if (frame.tag === CHANNEL_TAG.close) {
          const closing = closeOf(frame.payload);
          if (closing !== undefined) {
            socket.close(closing.code, closing.reason);
            controller.abort();
            return;
          }
          break;
        }
        const message = new Uint8Array(1 + frame.payload.length);
        message[0] = frame.tag;
        message.set(frame.payload, 1);
        socket.send(message);
      }
      socket.close(1011, `Worker ${lease.workerId ?? ""} stopped answering`);
      controller.abort();
    })();
  }

  return {
    open: async (_request, identity, lease) => {
      const controller = new AbortController();
      const workerId = lease.workerId ?? "";
      let relay: Response | ModuleTwoWayRelay;
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
        return refusalFor(error, workerId);
      }
      if (relay instanceof Response) return relay;
      return Object.assign((socket: LeaseSocket) => bridge(socket, relay, controller, lease), {
        abandon: () => controller.abort(),
      });
    },
  };
}
