import type { LeaseRecord } from "../core/index.js";
import {
  channelSocket,
  unknownLease,
  upgradeRequired,
  type WorkerContext,
  type WorkerModule,
} from "../modules/index.js";
import { MAX_TUNNEL_MESSAGE_BYTES } from "./limits.js";
import type { TunnelModuleConfig } from "./definition.js";
import { createTunnelSessions } from "./sessions.js";

export function createWorker(ctx: WorkerContext<TunnelModuleConfig>): WorkerModule {
  const sessions = createTunnelSessions({
    clock: ctx.clock,
    deviceTcp: ctx.deviceTcp,
    logger: ctx.logger,
  });
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
      sessions.attach(lease.id, device, channelSocket(pipe, ctx.clock, MAX_TUNNEL_MESSAGE_BYTES));
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
