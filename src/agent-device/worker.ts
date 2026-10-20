import type { HttpDispatch } from "../http/dispatcher-session.js";
import type { Identity } from "../auth/index.js";
import type { Clock } from "../ports/index.js";
import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { AgentDeviceModuleConfig } from "./definition.js";
import { FrontMap } from "./front/front-map.js";
import { InProcessHostLink, type LinkStatus } from "./front/host-link.js";
import { Renewals } from "./front/renewals.js";
import { AgentDeviceSupervisor, type AgentDevicePlatform } from "./host/agent-device-supervisor.js";
import { agentDeviceFindings } from "./host/availability-findings.js";
import { type AgentDeviceHealthProbe, NodeAgentDeviceHealthProbe } from "./host/health.js";
import { AgentDeviceHost } from "./host/host.js";
import { AgentDeviceLeaseEnd, ReleaseScopeRecord } from "./host/lease-end.js";
import { SupervisorAgentDeviceUpstream, type AgentDeviceUpstream } from "./host/upstream.js";
import {
  cancelWaitingAllocates,
  createAgentDeviceFront,
  disposeAgentDeviceEdge,
  type AgentDeviceFrontParts,
} from "./front/edge-parts.js";
import { frontReplyFor, notAvailable } from "./shared/replies.js";

interface AgentDeviceEdgeParts extends AgentDeviceFrontParts {
  readonly leaseEnd: AgentDeviceLeaseEnd;
}

function createAgentDeviceEdgeParts(
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
function agentDeviceRelayTarget(
  parts: AgentDeviceEdgeParts,
): (request: Request, tenant: string) => Promise<Response> {
  return async (request, tenant) => {
    const status = await parts.link.status();
    if (status.state === "unavailable") {
      return frontReplyFor(request, notAvailable(status.reason));
    }
    return parts.link.forward(request, {
      principal: tenant,
      name: tenant,
      role: "agent",
      via: "relay",
      ambient: false,
    });
  };
}

function agentDeviceCapabilitySource(parts: AgentDeviceEdgeParts): {
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

export interface AgentDeviceFakes {
  readonly upstream?: AgentDeviceUpstream;
  readonly health?: AgentDeviceHealthProbe;
}

/** why: the fakes are a test seam; without them the worker uses agent-device's real upstream and health probe. */
export function createWorkerWith(
  fakes: AgentDeviceFakes,
): (ctx: WorkerContext<AgentDeviceModuleConfig>) => WorkerModule {
  return (ctx) => {
    const supervisor = new AgentDeviceSupervisor({
      baseEnvironment: ctx.environment,
      clock: ctx.clock,
      config: ctx.config,
      driverEnvironment: ctx.leaseEnvironment,
      filesystem: ctx.filesystem,
      healthProbe: fakes.health ?? new NodeAgentDeviceHealthProbe(),
      home: ctx.dataDirectory,
      leaseMaxTtlMs: ctx.daemonConfig.lease.maxTtlMs,
      logger: ctx.logger,
      nodePath: ctx.nodePath,
      nodeVersion: ctx.nodeVersion,
      platforms: ctx.platforms,
      processRunner: ctx.processRunner,
      processSupervisor: ctx.processSupervisor,
      tcpProbe: ctx.tcpProbe,
    });
    const parts = createAgentDeviceEdgeParts(
      fakes.upstream ?? new SupervisorAgentDeviceUpstream(supervisor),
      ctx.clock,
      ctx.platforms,
    );
    return {
      capability: agentDeviceCapabilitySource(parts),
      findings: () =>
        agentDeviceFindings(supervisor.availability()).map(({ message, remedy }) => ({
          message,
          remedy,
        })),
      hooks: {
        // why: not awaited, since simlock's start never waits for agent-device, and a daemon that lost the socket race never gets here, so it reaps nothing.
        afterSocketClaimed: () => {
          if (fakes.upstream === undefined) void supervisor.start();
        },
        beforeDeviceReclaim: (ended, signal) => parts.leaseEnd.leaseEnded(ended, signal),
        beforeDrain: async () => {
          disposeAgentDeviceEdge(parts);
          await cancelWaitingAllocates(parts, (id) => ctx.cancelPending(id));
        },
        // why: before the drivers: the Android driver stops simlock's adb server, which this daemon's agent-device uses, and a client that finds no server forks its own.
        beforeDriversDispose: () => supervisor.stop(),
      },
      mount: (deps) => {
        const front = createAgentDeviceFront(parts, {
          clock: ctx.clock,
          dispatch: deps.dispatch as HttpDispatch,
          logger: ctx.logger,
          maxRunMs: ctx.daemonConfig.lease.maxTtlMs,
          ...(ctx.config.leaseTtlCapMs === undefined
            ? {}
            : { leaseTtlCapMs: ctx.config.leaseTtlCapMs }),
        });
        return (request, identity) => front.handle(request, identity as Identity);
      },
      relayTarget: agentDeviceRelayTarget(parts),
    };
  };
}

// fallow-ignore-next-line unused-export -- reached through the namespace of definition.ts's dynamic import.
export const createWorker = createWorkerWith({});
