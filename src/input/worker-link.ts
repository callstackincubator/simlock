import type { DeviceRecord, LeaseRecord } from "../core/index.js";
import type {
  ModuleInputs,
  ModuleLeaseSocketHandler,
  ModuleRelayTwoWayTarget,
} from "../modules/index.js";
import type { Clock, LeaseSocket } from "../ports/index.js";
import { channelSocket } from "./channel.js";
import { unknownLease } from "./refusal.js";
import { createInputSessions, type InputSessions } from "./sessions.js";

export interface InputRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface WorkerInputLinkOptions {
  readonly clock: Clock;
  readonly inputs: ModuleInputs;
  readonly registry: InputRegistry;
}

// why: the worker's own record is the truth for a lease a gateway names; a lease gone from it is
// unknown whoever asks, as `lease.get` answers.
export function createWorkerInputLink(base: WorkerInputLinkOptions): {
  readonly relayTwoWay: ModuleRelayTwoWayTarget;
  readonly socket: ModuleLeaseSocketHandler;
} {
  const options = {
    ...base,
    sessions: createInputSessions({ clock: base.clock, inputs: base.inputs }),
  };
  return {
    socket: {
      open: (_request, _identity, held) => {
        const lease = options.registry.snapshot.leases.find((entry) => entry.id === held.id);
        if (lease === undefined) return Promise.resolve(unknownLease(held.id));
        return Promise.resolve((socket) => serve(options, lease, socket));
      },
    },
    relayTwoWay: (_request, _tenant, leaseId, pipe) => {
      const lease = options.registry.snapshot.leases.find((entry) => entry.id === leaseId);
      if (lease === undefined) return Promise.resolve(unknownLease(leaseId ?? ""));
      serve(options, lease, channelSocket(pipe));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  };
}

function serve(
  options: WorkerInputLinkOptions & { readonly sessions: InputSessions },
  lease: LeaseRecord,
  socket: LeaseSocket,
): void {
  const device = options.registry.snapshot.devices.find((entry) => entry.id === lease.deviceId);
  if (device === undefined) return;
  options.sessions.attach(lease.id, device, socket);
}
