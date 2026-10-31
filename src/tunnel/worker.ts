import type { LeaseRecord } from "../core/index.js";
import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { TunnelModuleConfig } from "./definition.js";
import { createTunnelSessions } from "./sessions.js";

export function createWorker(ctx: WorkerContext<TunnelModuleConfig>): WorkerModule {
  const sessions = createTunnelSessions({ deviceTcp: ctx.deviceTcp });
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
    socket: {
      open: (_request, _identity, held) => {
        const lease: LeaseRecord | undefined = ctx.registry.snapshot.leases.find(
          (entry) => entry.id === held.id,
        );
        const device = ctx.registry.snapshot.devices.find((entry) => entry.id === lease?.deviceId);
        if (device === undefined) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve((socket) => {
          sessions.attach(device, socket);
        });
      },
    },
  };
}
