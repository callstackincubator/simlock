import { objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export type TunnelModuleConfig = Record<string, never>;

export const tunnelModule: OptionalModuleDefinition<TunnelModuleConfig> = {
  config: {
    defaults: {},
    gatewayKeys: [],
    validator: objectValidator({}),
  },
  http: {
    routes: [
      {
        method: "get",
        path: "/v1/leases/{id}/tunnel",
        description:
          "Open a tunnel socket for a lease's device over a WebSocket: the lease's holder or an operator. Each message is one tag byte, a 4-byte big-endian connection number and a payload. The holder sends HELLO with up to 8 tunnels, each {kind, devicePort}; the server answers READY with the same list, or REFUSED {code, message} and close 4003, and then nothing the HELLO named stays set up. Today only reverse tunnels are served: the device's connections to devicePort arrive as OPEN and DATA, under a 262144-byte window per direction. The socket closes 4001 with the lease-end reason when the lease ends, and 1001 when the daemon stops. A lease the caller does not own answers 404, as an unknown one does. A plain GET without an upgrade answers 426. Served only when capabilities.tunnel.enabled is true on the daemon that answers.",
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
        },
      },
    ],
  },
  loadWorker: () => import("./worker.js"),
  name: "tunnel",
};
