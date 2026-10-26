import type { DeviceRecord, LeaseRecord } from "../core/index.js";
import type {
  ModuleEndedLease,
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
  readonly leaseEnded: (ended: ModuleEndedLease) => Promise<void>;
  readonly drain: () => Promise<void>;
} {
  const options = {
    ...base,
    sessions: createInputSessions({
      clock: base.clock,
      inputs: base.inputs,
      leaseExists: (leaseId) => base.registry.snapshot.leases.some((entry) => entry.id === leaseId),
    }),
  };
  return {
    drain: () => {
      options.sessions.drain();
      return Promise.resolve();
    },
    leaseEnded: (ended) => {
      options.sessions.end(ended.leaseId, ended.reason);
      return Promise.resolve();
    },
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
      serve(options, lease, channelSocket(pipe, options.clock));
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
