import type { SimlockAdminClient } from "../admin/index.js";

export interface GatewayWorkerClient extends SimlockAdminClient {
  relayRequest(input: unknown, hooks: unknown): Promise<unknown>;
  relayBody(input: unknown): Promise<unknown>;
  relayCancel(input: unknown): Promise<unknown>;
}
