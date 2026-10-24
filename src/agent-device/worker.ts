import type { HttpDispatch } from "../http/dispatcher-session.js";
import type { Identity } from "../auth/index.js";
import type { Clock } from "../ports/index.js";
import type { ModuleRegistryView, WorkerContext, WorkerModule } from "../modules/index.js";
import type { AgentDeviceModuleConfig } from "./definition.js";
import { FrontMap } from "./front/front-map.js";
import { RoutedHostLink, type LinkStatus } from "./front/host-link.js";
import { Renewals } from "./front/renewals.js";
import {
  AgentDeviceSupervisor,
  type AgentDevicePlatform,
  type AgentDeviceRole,
} from "./host/agent-device-supervisor.js";
import { agentDeviceFindings, isAbsentByDefault } from "./host/availability-findings.js";
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
  readonly link: RoutedHostLink;
  // why: one participant per daemon; for each ended lease only the one whose record holds its scope sends a release.
  readonly leaseEnds: readonly AgentDeviceLeaseEnd[];
}

function createAgentDeviceEdgeParts(
  upstream: AgentDeviceUpstream,
  phoneUpstream: AgentDeviceUpstream,
  clock: Clock,
  platforms: readonly AgentDevicePlatform[],
  registry: ModuleRegistryView,
): AgentDeviceEdgeParts {
  const simulatorRecord = new ReleaseScopeRecord();
  const phoneRecord = new ReleaseScopeRecord();
  return {
    leaseEnds: [
      new AgentDeviceLeaseEnd(upstream, simulatorRecord),
      new AgentDeviceLeaseEnd(phoneUpstream, phoneRecord),
    ],
    link: new RoutedHostLink(
      {
        phones: new AgentDeviceHost(phoneUpstream, platforms, phoneRecord),
        simulators: new AgentDeviceHost(upstream, platforms, simulatorRecord),
      },
      registry,
    ),
    map: new FrontMap(clock),
    renewals: new Renewals(clock),
  };
}

// why: a relayed request's tenant is the gateway's prefixed principal, which the host treats as the requester, so the worker's own tokens never share a session with it.
function agentDeviceRelayTarget(
  parts: AgentDeviceEdgeParts,
): (request: Request, tenant: string, leaseId: string | undefined) => Promise<Response> {
  return async (request, tenant, leaseId) => {
    const status = await parts.link.status(leaseId);
    if (status.state === "unavailable") {
      return frontReplyFor(request, notAvailable(status.reason));
    }
    return parts.link.forward(
      request,
      {
        principal: tenant,
        name: tenant,
        role: "agent",
        via: "relay",
        ambient: false,
      },
      leaseId,
    );
  };
}

function agentDeviceCapabilitySource(
  parts: AgentDeviceEdgeParts,
  absent: () => boolean,
): {
  readonly name: string;
  readonly read: () => Promise<{
    readonly state: "available" | "unavailable" | "off";
    readonly reason?: string;
  }>;
} {
  return {
    name: "agent-device",
    read: async () => {
      if (absent()) return { state: "off" };
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
  readonly phoneUpstream?: AgentDeviceUpstream;
  readonly health?: AgentDeviceHealthProbe;
}

/** why: the fakes are a test seam; without them the worker uses agent-device's real upstream and health probe. */
export function createWorkerWith(
  fakes: AgentDeviceFakes,
): (ctx: WorkerContext<AgentDeviceModuleConfig>) => WorkerModule {
  return (ctx) => {
    const supervise = (role: AgentDeviceRole) =>
      new AgentDeviceSupervisor({
        baseEnvironment: ctx.environment,
        clock: ctx.clock,
        config: ctx.config,
        driverEnvironment: ctx.leaseEnvironment,
        filesystem: ctx.filesystem,
        healthProbe: fakes.health ?? new NodeAgentDeviceHealthProbe(),
        home: ctx.dataDirectory,
        ...(ctx.config.ios === undefined ? {} : { ios: ctx.config.ios }),
        leaseMaxTtlMs: ctx.daemonConfig.lease.maxTtlMs,
        logger: ctx.logger,
        nodePath: ctx.nodePath,
        nodeVersion: ctx.nodeVersion,
        platforms: ctx.platforms,
        processRunner: ctx.processRunner,
        processSupervisor: ctx.processSupervisor,
        role,
        tcpProbe: ctx.tcpProbe,
      });
    const supervisor = supervise("simulators");
    const phoneSupervisor = supervise("phones");
    const parts = createAgentDeviceEdgeParts(
      fakes.upstream ?? new SupervisorAgentDeviceUpstream(supervisor),
      fakes.phoneUpstream ?? new SupervisorAgentDeviceUpstream(phoneSupervisor),
      ctx.clock,
      ctx.platforms,
      ctx.registry,
    );
    return {
      capability: agentDeviceCapabilitySource(parts, () =>
        isAbsentByDefault(supervisor.availability(), ctx.enabledByDefault),
      ),
      findings: () =>
        [
          ...agentDeviceFindings(supervisor.availability(), "simulators", ctx.enabledByDefault),
          ...agentDeviceFindings(phoneSupervisor.availability(), "phones", ctx.enabledByDefault),
        ].map(({ message, remedy }) => ({ message, remedy })),
      hooks: {
        // why: not awaited, since simlock's start never waits for agent-device, and a daemon that lost the socket race never gets here, so it reaps nothing.
        afterSocketClaimed: () => {
          if (fakes.upstream === undefined) {
            void supervisor.start().then(() => phoneSupervisor.start());
          }
        },
        beforeDeviceReclaim: async (ended, signal) => {
          try {
            await Promise.all(parts.leaseEnds.map((end) => end.leaseEnded(ended, signal)));
          } finally {
            parts.link.forget(ended.leaseId);
          }
        },
        beforeDrain: async () => {
          disposeAgentDeviceEdge(parts);
          await cancelWaitingAllocates(parts, (id) => ctx.cancelPending(id));
        },
        // why: before the drivers: the Android driver stops simlock's adb server, which this daemon's agent-device uses, and a client that finds no server forks its own.
        beforeDriversDispose: async () => {
          await Promise.all([supervisor.stop(), phoneSupervisor.stop()]);
        },
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
