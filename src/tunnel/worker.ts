import type { LeaseRecord } from "../core/index.js";
import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { TunnelModuleConfig } from "./definition.js";
import { channelSocket } from "./channel.js";
import { unknownLease, upgradeRequired } from "./refusal.js";
import { createTunnelSessions } from "./sessions.js";

export function createWorker(ctx: WorkerContext<TunnelModuleConfig>): WorkerModule {
  const sessions = createTunnelSessions({ deviceTcp: ctx.deviceTcp, logger: ctx.logger });
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
    hooks: {
      beforeDeviceReclaim: (ended, signal) => sessions.end(ended.leaseId, ended.reason, signal),
      beforeDrain: () => sessions.drain(),
    },
    leaseRoute: () => Promise.resolve(upgradeRequired()),
    relayTwoWay: (_request, _tenant, leaseId, pipe) => {
      const lease = ctx.registry.snapshot.leases.find((entry) => entry.id === leaseId);
      const device = ctx.registry.snapshot.devices.find((entry) => entry.id === lease?.deviceId);
      if (lease === undefined || device === undefined) {
        return Promise.resolve(unknownLease(leaseId ?? ""));
      }
      sessions.attach(lease.id, device, channelSocket(pipe, ctx.clock));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
    socket: {
      open: (_request, _identity, held) => {
        const lease: LeaseRecord | undefined = ctx.registry.snapshot.leases.find(
          (entry) => entry.id === held.id,
        );
        const device = ctx.registry.snapshot.devices.find((entry) => entry.id === lease?.deviceId);
        if (device === undefined) return Promise.resolve(unknownLease(held.id));
        return Promise.resolve((socket) => {
          sessions.attach(held.id, device, socket);
        });
      },
    },
  };
}
