import type {
  ModuleIdentity,
  ModuleLease,
  ModuleLeaseSocketAccept,
  ModuleTwoWayRelay,
} from "../modules/index.js";
import type { LeaseSocket } from "../ports/index.js";
import { readFrames } from "./framing.js";

export interface GatewayInputLinkOptions {
  readonly relayTwoWay: (
    workerId: string,
    request: Request,
    tenant: string,
    leaseId?: string,
  ) => Promise<Response | ModuleTwoWayRelay>;
  readonly requesterPrefix: string;
}

export function createGatewayInputLink(options: GatewayInputLinkOptions): {
  open(
    request: Request,
    identity: ModuleIdentity,
    lease: ModuleLease,
  ): Promise<Response | ModuleLeaseSocketAccept>;
} {
  return {
    open: async (_request, identity, lease) => {
      const controller = new AbortController();
      const relay = await options.relayTwoWay(
        lease.workerId ?? "",
        new Request(`http://simlock-worker/input/leases/${encodeURIComponent(lease.id)}`, {
          method: "GET",
          signal: controller.signal,
        }),
        `${options.requesterPrefix}${identity.principal}`,
        lease.workerLeaseId,
      );
      if (relay instanceof Response) return relay;
      return (socket) => bridge(socket, relay, controller);
    },
  };
}

function bridge(socket: LeaseSocket, relay: ModuleTwoWayRelay, controller: AbortController): void {
  socket.onClose(() => controller.abort());
  void (async () => {
    for await (const frame of readFrames(relay.readable)) {
      const message = new Uint8Array(1 + frame.payload.length);
      message[0] = frame.tag;
      message.set(frame.payload, 1);
      socket.send(message);
    }
  })();
}
