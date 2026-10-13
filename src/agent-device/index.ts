import type { HttpDispatch } from "../http/dispatcher-session.js";
import type { HttpMount } from "../http/app.js";
import type { Clock, Logger } from "../ports/index.js";
import { FrontMap } from "./front/front-map.js";
import { createFront } from "./front/front.js";
import { InProcessHostLink, type HostLink } from "./front/host-link.js";
import { Renewals } from "./front/renewals.js";
import { AgentDeviceHost } from "./host/host.js";
import { AgentDeviceLeaseEnd, ReleaseScopeRecord } from "./host/lease-end.js";
import type { AgentDeviceUpstream } from "./host/upstream.js";

export { agentDeviceFindings } from "./host/availability-findings.js";
export { AgentDeviceSupervisor } from "./host/agent-device-supervisor.js";
// fallow-ignore-next-line unused-type -- the shape `AgentDeviceSupervisor.availability()` returns, which `agentDeviceFindings` reads.
export type { AgentDeviceAvailability } from "./host/agent-device-supervisor.js";
export type { AgentDeviceUpstream } from "./host/upstream.js";
export { SupervisorAgentDeviceUpstream } from "./host/upstream.js";
export { type AgentDeviceHealthProbe, NodeAgentDeviceHealthProbe } from "./host/health.js";

export interface AgentDeviceEdgeParts {
  readonly leaseEnd: AgentDeviceLeaseEnd;
  readonly link: HostLink;
  readonly map: FrontMap;
  readonly renewals: Renewals;
}

export function createAgentDeviceEdgeParts(
  upstream: AgentDeviceUpstream,
  clock: Clock,
): AgentDeviceEdgeParts {
  const record = new ReleaseScopeRecord();
  return {
    leaseEnd: new AgentDeviceLeaseEnd(upstream, record),
    link: new InProcessHostLink(new AgentDeviceHost(upstream, record)),
    map: new FrontMap(clock),
    renewals: new Renewals(clock),
  };
}

// why: a stop ends the gateway's sockets, so the calls that end then must send no renewal that races leasing teardown.
export function disposeAgentDeviceEdge(parts: AgentDeviceEdgeParts): void {
  parts.renewals.dispose();
}

// why: a stop refuses every dispatch, so waiting allocates' lease requests are cancelled through leasing directly, before the gateway stops; otherwise they stay open across a restart.
export async function cancelWaitingAllocates(
  parts: AgentDeviceEdgeParts,
  cancel: (requesterId: string) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(parts.map.waitingIds().map((id) => cancel(id)));
}

export function createAgentDeviceFront(
  parts: AgentDeviceEdgeParts,
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
