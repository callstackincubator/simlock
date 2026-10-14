import type { HttpDispatch } from "../http/dispatcher-session.js";
import type { HttpMount } from "../http/app.js";
import type { Clock, Logger } from "../ports/index.js";
import { FrontMap } from "./front/front-map.js";
import { createFront } from "./front/front.js";
import { InProcessHostLink, type HostLink, type LinkStatus } from "./front/host-link.js";
import { RelayHostLink, type FleetPort } from "./front/relay-host-link.js";
import { frontReplyFor, notAvailable } from "./shared/replies.js";
import { Renewals } from "./front/renewals.js";
import type { AgentDevicePlatform } from "./host/agent-device-supervisor.js";
import { AgentDeviceHost } from "./host/host.js";
import { AgentDeviceLeaseEnd, ReleaseScopeRecord } from "./host/lease-end.js";
import type { AgentDeviceUpstream } from "./host/upstream.js";

export type { FleetPort, FleetWorker } from "./front/relay-host-link.js";
export { agentDeviceFindings } from "./host/availability-findings.js";
export { AgentDeviceSupervisor } from "./host/agent-device-supervisor.js";
// fallow-ignore-next-line unused-type -- the shape `AgentDeviceSupervisor.availability()` returns, which `agentDeviceFindings` reads.
export type { AgentDeviceAvailability } from "./host/agent-device-supervisor.js";
export type { AgentDeviceUpstream } from "./host/upstream.js";
export { SupervisorAgentDeviceUpstream } from "./host/upstream.js";
export { type AgentDeviceHealthProbe, NodeAgentDeviceHealthProbe } from "./host/health.js";

export interface AgentDeviceFrontParts {
  readonly link: HostLink;
  readonly map: FrontMap;
  readonly renewals: Renewals;
}

export interface AgentDeviceEdgeParts extends AgentDeviceFrontParts {
  readonly leaseEnd: AgentDeviceLeaseEnd;
}

export function createGatewayAgentDeviceFrontParts(
  fleet: FleetPort,
  clock: Clock,
  leaseMaxTtlMs: number,
): AgentDeviceFrontParts {
  return {
    link: new RelayHostLink({ clock, fleet, leaseMaxTtlMs }),
    map: new FrontMap(clock),
    renewals: new Renewals(clock),
  };
}

export function createAgentDeviceEdgeParts(
  upstream: AgentDeviceUpstream,
  clock: Clock,
  platforms: readonly AgentDevicePlatform[],
): AgentDeviceEdgeParts {
  const record = new ReleaseScopeRecord();
  return {
    leaseEnd: new AgentDeviceLeaseEnd(upstream, record),
    link: new InProcessHostLink(new AgentDeviceHost(upstream, platforms, record)),
    map: new FrontMap(clock),
    renewals: new Renewals(clock),
  };
}

// why: a relayed request's tenant is the gateway's prefixed principal, which the host treats as the requester, so the worker's own tokens never share a session with it.
export function agentDeviceRelayTarget(
  parts: AgentDeviceEdgeParts,
): (request: Request, tenant: string) => Promise<Response> {
  return async (request, tenant) => {
    const status = await parts.link.status();
    if (status.state === "unavailable") {
      return frontReplyFor(request, notAvailable(status.reason));
    }
    return parts.link.forward(request, { requesterId: tenant, role: "agent" });
  };
}

export function agentDeviceCapabilitySource(parts: AgentDeviceEdgeParts): {
  readonly name: string;
  readonly read: () => Promise<{
    readonly state: "available" | "unavailable";
    readonly reason?: string;
  }>;
} {
  return {
    name: "agent-device",
    read: async () => {
      // why: a status read without a lease id is never "unreachable"; only a lease has a worker to reach.
      const status = (await parts.link.status()) as Exclude<LinkStatus, { state: "unreachable" }>;
      return status.state === "running"
        ? { state: "available" }
        : { reason: status.reason, state: "unavailable" };
    },
  };
}

// why: a stop ends the gateway's sockets, so the calls that end then must send no renewal that races leasing teardown.
export function disposeAgentDeviceEdge(parts: AgentDeviceFrontParts): void {
  parts.renewals.dispose();
  parts.link.dispose?.();
}

// why: a stop refuses every dispatch, so waiting allocates' lease requests are cancelled through leasing directly, before the gateway stops; otherwise they stay open across a restart.
export async function cancelWaitingAllocates(
  parts: AgentDeviceFrontParts,
  cancel: (requesterId: string) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(parts.map.waitingIds().map((id) => cancel(id)));
}

export function createAgentDeviceFront(
  parts: AgentDeviceFrontParts,
  deps: {
    readonly dispatch: HttpDispatch;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly leaseTtlCapMs?: number;
    readonly maxRunMs: number;
  },
): HttpMount {
  return createFront({ ...deps, link: parts.link, map: parts.map, renewals: parts.renewals });
}
