import type { SimlockAdminClient } from "../admin/index.js";
import type { RelayClientMethods } from "../simlock-client/client.js";

// why: `simlock/admin` exports no relay method (ADR 0026); only the gateway's own session on a worker makes them.

export interface GatewayWorkerClient extends SimlockAdminClient, RelayClientMethods {}
