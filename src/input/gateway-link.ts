import type {
  ModuleIdentity,
  ModuleLease,
  ModuleLeaseSocketAccept,
  ModuleTwoWayRelay,
} from "../modules/index.js";
import type { LeaseSocket } from "../ports/index.js";
import { readFrames } from "./framing.js";
import { unavailable } from "./refusal.js";

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
      const workerId = lease.workerId ?? "";
      let relay: Response | ModuleTwoWayRelay;
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
        return refusalFor(error, workerId, lease.id);
      }
      if (relay instanceof Response) return relay;
      return (socket) => bridge(socket, relay, controller);
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
