import { createGatewayChannelLink, type GatewayChannelLinkOptions } from "../modules/index.js";
import { encodeTunnelFrame, TUNNEL_REFUSED_CLOSE, TUNNEL_TAG } from "../contract/index.js";
import { MAX_TUNNEL_MESSAGE_BYTES } from "./limits.js";

export type GatewayTunnelLinkOptions = GatewayChannelLinkOptions;

// why: a frame over the limit would break the channel for the whole lease, so the gateway refuses it as the worker refuses a bad frame.
const OVERSIZE_MESSAGE = `a frame is longer than ${String(MAX_TUNNEL_MESSAGE_BYTES)} bytes`;

export function createGatewayTunnelLink(
  options: GatewayTunnelLinkOptions,
): ReturnType<typeof createGatewayChannelLink> {
  return createGatewayChannelLink(options, {
    missing: (workerId) => ({
      code: "TUNNEL_UNAVAILABLE",
      message: `Tunnels are off on worker ${workerId}; turn on capabilities.tunnel.enabled there`,
    }),
    oversize: {
      limit: MAX_TUNNEL_MESSAGE_BYTES,
      refuse: {
        code: TUNNEL_REFUSED_CLOSE,
        frame: encodeTunnelFrame(
          TUNNEL_TAG.refused,
          0,
          JSON.stringify({ code: "BAD_REQUEST", message: OVERSIZE_MESSAGE }),
        ),
        reason: OVERSIZE_MESSAGE,
      },
    },
    path: "/tunnel/leases",
    readLimit: MAX_TUNNEL_MESSAGE_BYTES,
    socketName: "tunnel socket",
  });
}
