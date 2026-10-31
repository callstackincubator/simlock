import type {
  ModuleIdentity,
  ModuleLease,
  ModuleLeaseSocketAccept,
  ModuleTwoWayRelay,
} from "../modules/index.js";
import type { LeaseSocket } from "../ports/index.js";
import { encodeFrame, MAX_TUNNEL_MESSAGE_BYTES, readFrames } from "./framing.js";

export interface GatewayTunnelLinkOptions {
  readonly relayTwoWay: (
    workerId: string,
    request: Request,
    tenant: string,
    leaseId?: string,
  ) => Promise<Response | ModuleTwoWayRelay>;
  readonly requesterPrefix: string;
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
      const relay = await options.relayTwoWay(
        lease.workerId ?? "",
        new Request(`http://simlock-worker/tunnel/leases/${encodeURIComponent(lease.id)}`, {
          method: "GET",
          signal: controller.signal,
        }),
        `${options.requesterPrefix}${identity.principal}`,
        lease.workerLeaseId,
      );
      if (relay instanceof Response) return relay;
      return Object.assign((socket: LeaseSocket) => bridge(socket, relay, controller, lease), {
        abandon: () => controller.abort(),
      });
    },
  };
}
