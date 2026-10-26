import { objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export type InputModuleConfig = Record<string, never>;

export const inputModule: OptionalModuleDefinition<InputModuleConfig> = {
  config: {
    defaults: {},
    gatewayKeys: [],
    validator: objectValidator({}),
  },
  http: {
    routes: [
      {
        method: "get",
        path: "/v1/leases/{id}/input",
        description:
          "Send taps, swipes, keys and buttons to a lease's device over a WebSocket, in expo serve-sim's messages: the lease's holder or an operator. Each message is one tag byte and UTF-8 JSON. The server sends 0x83 (input admitted), then 0x82 with the screen's {width, height, orientation} (and inputUnavailable or keyboardUnavailable when the device cannot take that input). The socket closes 4001 with the lease-end reason (explicit, killed, expired or device-lost) when the lease ends, 1011 when the lease's worker stops answering, 1001 when the daemon stops, and 1013 when the device input failed or 8 sockets are already open. A lease the caller does not own answers 404, as an unknown one does. A plain GET without an upgrade answers 426. Served only when capabilities.input.enabled is true on the daemon that answers; through a gateway the lease's worker needs it too.",
        statuses: {
          101: { description: "The upgrade to a WebSocket." },
          404: {
            description: "No such lease, or not the caller's.",
            errorCodes: ["UNKNOWN_LEASE"],
          },
          426: {
            description: "The request is not a WebSocket upgrade.",
            errorCodes: ["BAD_REQUEST"],
          },
          503: {
            description:
              "A gateway's worker does not take input, or does not answer the socket within 10 s.",
            errorCodes: ["INPUT_UNAVAILABLE", "WORKER_UNREACHABLE"],
          },
        },
      },
    ],
  },
  loadGateway: () => import("./gateway.js"),
  loadWorker: () => import("./worker.js"),
  name: "input",
};
