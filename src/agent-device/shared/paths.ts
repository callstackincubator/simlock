export const FRONT_MOUNT = "agent-device";

export const FRONT_PREFIX = `/v1/${FRONT_MOUNT}`;

export const PROXY_BASE_PATH = "/agent-device";

// why: agent-device sends this header on every upload, artifact download and diagnostics request once it holds a lease; a gateway routes by it.
export const LEASE_HEADER = "x-agent-device-lease-id";
