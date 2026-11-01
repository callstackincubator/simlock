import { MAX_INPUT_MESSAGE_BYTES } from "../core/index.js";
import { createGatewayChannelLink, type GatewayChannelLinkOptions } from "../modules/index.js";

export type GatewayInputLinkOptions = GatewayChannelLinkOptions;

export function createGatewayInputLink(
  options: GatewayInputLinkOptions,
): ReturnType<typeof createGatewayChannelLink> {
  return createGatewayChannelLink(options, {
    missing: (workerId, lease) => ({
      code: "INPUT_UNAVAILABLE",
      message: `Worker ${workerId} does not take input for lease ${lease.id}; turn on capabilities.input.enabled there`,
    }),
    // why: a frame over the limit would end the channel for everyone on the lease, and a message that long is dropped on every door.
    oversize: { limit: MAX_INPUT_MESSAGE_BYTES },
    path: "/input/leases",
    readLimit: MAX_INPUT_MESSAGE_BYTES + 1,
    socketName: "input socket",
  });
}
