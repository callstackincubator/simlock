import type { TokenIdentity } from "../../http/token-store.js";
import type { AgentDevicePlatform } from "../host/agent-device-supervisor.js";
import type { AgentDeviceHost } from "../host/host.js";

export interface HostLink {
  status(): Promise<
    | {
        readonly state: "running";
        readonly leaseMaxTtlMs: number;
        readonly platforms: readonly AgentDevicePlatform[];
      }
    | { readonly state: "unavailable"; readonly reason: string }
  >;
  forward(request: Request, identity: TokenIdentity): Promise<Response>;
}

export class InProcessHostLink implements HostLink {
  constructor(private readonly host: AgentDeviceHost) {}

  status(): ReturnType<HostLink["status"]> {
    return this.host.status();
  }

  forward(request: Request, identity: TokenIdentity): Promise<Response> {
    return this.host.forward(request, identity);
  }
}
