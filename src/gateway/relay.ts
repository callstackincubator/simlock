import type { WorkerDirectory } from "./fleet-ports.js";

export interface GatewayRelayOptions {
  readonly directory: WorkerDirectory;
  readonly deadlineMs?: number;
}

export interface GatewayRelayCall {
  readonly target: string;
  readonly request: Request;
  readonly tenant: string;
  readonly leaseId?: string;
}

export class GatewayRelay {
  constructor(readonly options: GatewayRelayOptions) {}

  relay(_workerId: string, _call: GatewayRelayCall): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 501 }));
  }
}
