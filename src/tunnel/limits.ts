import { TUNNEL_MAX_DATA_BYTES } from "../contract/index.js";

// why: a tunnel message is `[tag][conn u32][payload]` with a payload of at most one DATA's bytes, and the channel carries one message per frame.
export const MAX_TUNNEL_MESSAGE_BYTES = 5 + TUNNEL_MAX_DATA_BYTES;
