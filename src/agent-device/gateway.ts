import type { HttpDispatch } from "../http/dispatcher-session.js";
import type { TokenIdentity } from "../http/token-store.js";
import type { FleetLease, GatewayContext, GatewayModule, WorkerView } from "../modules/index.js";
import type { AgentDeviceModuleConfig } from "./definition.js";
import {
  cancelWaitingAllocates,
  createAgentDeviceFront,
  createGatewayAgentDeviceFrontParts,
  disposeAgentDeviceEdge,
  type FleetPort,
  type FleetWorker,
} from "./front/edge-parts.js";

type Context = GatewayContext<AgentDeviceModuleConfig>;
type FleetLeaseFacts = ReturnType<FleetPort["leasesOf"]>[number];

// why: the context lists workers whose agent-device is available; the rest of what makes one fit for agent-device is judged here.
function serving(view: WorkerView, withDrained: boolean): FleetWorker | undefined {
  const maxTtlMs = view.lease?.maxTtlMs;
  if (
    (view.drained && !withDrained) ||
    view.catalogReadAt === undefined ||
    maxTtlMs === undefined
  ) {
    return undefined;
  }
  const platforms = (view.catalog ?? []).flatMap((entry) =>
    entry.platform === "ios" || entry.platform === "android" ? [entry.platform] : [],
  );
  return { id: view.id, leaseMaxTtlMs: maxTtlMs, platforms };
}

function fleetPort(ctx: Context): FleetPort {
  return {
    capableWorkers: () =>
      ctx.serving().flatMap((view) => {
        const worker = serving(view, false);
        return worker === undefined ? [] : [worker];
      }),
    holder: (workerId) => {
      const view = ctx.serving().find((candidate) => candidate.id === workerId);
      return view === undefined ? undefined : serving(view, true);
    },
    instanceId: ctx.instanceId,
    leasesOf: (ownerId) =>
      ctx.leases
        .all()
        .filter((entry) => entry.ownerId === ownerId)
        .map((entry) => leaseFacts(ctx, entry)),
    leaseOf: (leaseId) => {
      const entry = ctx.leases.resolve(leaseId);
      return entry === undefined ? undefined : { ownerId: entry.ownerId, workerId: entry.workerId };
    },
    onLeaseRemoved: (listener) => {
      ctx.leases.onRemoved((entry) =>
        listener({
          leaseId: entry.gatewayLeaseId,
          ownerId: entry.ownerId,
          workerId: entry.workerId,
        }),
      );
    },
    reach: (workerId) => {
      const view = ctx.worker(workerId);
      return view === undefined
        ? undefined
        : {
            connected: view.connection === "connected",
            refreshed: view.catalogReadAt !== undefined,
          };
    },
    // why: looked up at each call, so a test that replaces the relay's method sits between the link and the worker.
    relay: (workerId, request, tenant, leaseId) => ctx.relay(workerId, request, tenant, leaseId),
    startedAt: ctx.startedAt,
  };
}

// why: the worker's view lists the lease, its granted device and the model's class in its catalog; a lease missing any of them is not offered for adoption.
function listedLease(
  ctx: Context,
  view: WorkerView | undefined,
  entry: FleetLease,
): FleetLeaseFacts["listed"] {
  const record = view?.leases?.find((lease) => lease.id === entry.workerLeaseId);
  if (view === undefined || record === undefined) return undefined;
  const device = ctx
    .grantedDevices()
    .find((granted) => granted.workerId === entry.workerId && granted.id === record.deviceId);
  if (device === undefined) return undefined;
  return describeDevice(view, record, device);
}

function describeDevice(
  view: WorkerView,
  record: { readonly ttlMs: number; readonly ttlDeadline: number },
  device: ReturnType<Context["grantedDevices"]>[number],
): FleetLeaseFacts["listed"] {
  const { platform, model } = device.spec;
  if (device.address === undefined || (platform !== "ios" && platform !== "android")) {
    return undefined;
  }
  const deviceClass = view.catalog?.find((catalog) => catalog.platform === platform)?.modelClasses[
    model
  ];
  return {
    address: device.address,
    model,
    platform,
    ttlDeadline: record.ttlDeadline,
    ttlMs: record.ttlMs,
    ...(deviceClass === undefined ? {} : { deviceClass }),
  };
}

function leaseFacts(ctx: Context, entry: FleetLease): FleetLeaseFacts {
  const view = ctx.worker(entry.workerId);
  const listed = listedLease(ctx, view, entry);
  return {
    connected: view?.connection === "connected",
    leaseId: entry.gatewayLeaseId,
    refreshed: view?.catalogReadAt !== undefined,
    requesterId: entry.requesterId,
    workerId: entry.workerId,
    ...(listed === undefined ? {} : { listed }),
  };
}

// fallow-ignore-next-line unused-export -- reached through the namespace of definition.ts's dynamic import.
export function createGateway(ctx: Context): GatewayModule {
  const parts = createGatewayAgentDeviceFrontParts(
    fleetPort(ctx),
    ctx.clock,
    ctx.daemonConfig.lease.maxTtlMs,
  );
  return {
    hooks: {
      beforeDrain: async () => {
        disposeAgentDeviceEdge(parts);
        await cancelWaitingAllocates(parts, (id) => ctx.cancelPending(id));
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
      return (request, identity) => front.handle(request, identity as TokenIdentity);
    },
  };
}
