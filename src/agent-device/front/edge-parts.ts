import type { HttpDispatch } from "../../http/dispatcher-session.js";
import type { HttpMount } from "../../http/app.js";
import type { Clock, Logger } from "../../ports/index.js";
import { FrontMap } from "./front-map.js";
import { createFront } from "./front.js";
import type { HostLink } from "./host-link.js";
import { RelayHostLink, type FleetPort } from "./relay-host-link.js";
import { Renewals } from "./renewals.js";

export type { FleetPort, FleetWorker } from "./relay-host-link.js";

export interface AgentDeviceFrontParts {
  readonly link: HostLink;
  readonly map: FrontMap;
  readonly renewals: Renewals;
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
