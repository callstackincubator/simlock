import { integerInRange, objectValidator } from "../core/index.js";
import type { OptionalModuleDefinition } from "../modules/index.js";

export interface StreamModuleConfig {
  readonly fps: number;
  readonly maxDimension: number;
  readonly bitrateKbps: number;
}

// why: the module is called `stream`, so its capability, its relay target and its route segment are
// one word; the picture settings are what a worker encodes with, and a gateway that only relays a
// stream reads none of them.
export const streamModule: OptionalModuleDefinition<StreamModuleConfig> = {
  config: {
    defaults: { bitrateKbps: 1_500, fps: 30, maxDimension: 720 },
    gatewayKeys: [],
    validator: objectValidator({
      bitrateKbps: integerInRange(100, 40_000),
      fps: integerInRange(1, 60),
      maxDimension: integerInRange(96, 4096),
    }),
  },
  http: {
    routes: [
      {
        method: "get",
        path: "/v1/stream/leases/{id}",
        description:
          "Watch the screen of a leased device. Served only when capabilities.stream.enabled is true. A gateway keeps a worker's refusal with its code.",
        statuses: {
          200: {
            description: "The picture, as a binary body of frames; its codec and size are headers.",
            contentTypes: [
              "application/vnd.simlock.stream+h264",
              "application/vnd.simlock.stream+mjpeg",
            ],
            headers: {
              "simlock-stream-codec": "The codec of the body: h264 or mjpeg.",
              "simlock-stream-fps": "Frames per second.",
              "simlock-stream-height": "Picture height in pixels.",
              "simlock-stream-width": "Picture width in pixels.",
              "x-simlock-lease": "The lease being watched.",
            },
          },
          404: {
            description: "No such lease, or no such stream path.",
            errorCodes: ["UNKNOWN_LEASE"],
          },
          405: { description: "A stream is read, not written.", errorCodes: ["BAD_REQUEST"] },
          415: {
            description: "The leased device cannot be streamed.",
            errorCodes: ["STREAM_NOT_SUPPORTED"],
          },
          500: { description: "The stream failed unexpectedly.", errorCodes: ["INTERNAL"] },
          502: {
            description: "A gateway's worker answered success with no picture.",
            errorCodes: ["STREAM_UNAVAILABLE"],
          },
          503: {
            description: "The stream is not available, or a gateway cannot reach the worker.",
            errorCodes: ["STREAM_UNAVAILABLE", "WORKER_UNREACHABLE"],
          },
        },
      },
    ],
  },
  loadGateway: () => import("./gateway.js"),
  loadWorker: () => import("./worker.js"),
  name: "stream",
};
