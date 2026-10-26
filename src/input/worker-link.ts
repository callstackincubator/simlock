import {
  encodeInputMessage,
  INPUT_TAG,
  isUnavailableInput,
  toDriverDevice,
  UNAVAILABLE_INPUT_CONFIG,
  type DeviceRecord,
  type LeaseRecord,
} from "../core/index.js";
import type {
  ModuleInputs,
  ModuleLeaseSocketHandler,
  ModuleRelayTwoWayTarget,
} from "../modules/index.js";
import type { LeaseSocket } from "../ports/index.js";
import { channelSocket } from "./channel.js";
import { unknownLease } from "./refusal.js";

export interface InputRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface WorkerInputLinkOptions {
  readonly inputs: ModuleInputs;
  readonly registry: InputRegistry;
}

// why: the worker's own record is the truth for a lease a gateway names; a lease gone from it is
// unknown whoever asks, as `lease.get` answers.
export function createWorkerInputLink(options: WorkerInputLinkOptions): {
  readonly relayTwoWay: ModuleRelayTwoWayTarget;
  readonly socket: ModuleLeaseSocketHandler;
} {
  return {
    socket: {
      open: (_request, _identity, held) => {
        const lease = options.registry.snapshot.leases.find((entry) => entry.id === held.id);
        if (lease === undefined) return Promise.resolve(unknownLease(held.id));
        return Promise.resolve((socket) => void serve(options, lease, socket));
      },
    },
    relayTwoWay: (_request, _tenant, leaseId, pipe) => {
      const lease = options.registry.snapshot.leases.find((entry) => entry.id === leaseId);
      if (lease === undefined) return Promise.resolve(unknownLease(leaseId ?? ""));
      void serve(options, lease, channelSocket(pipe));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  };
}

async function serve(
  options: WorkerInputLinkOptions,
  lease: LeaseRecord,
  socket: LeaseSocket,
): Promise<void> {
  const device = options.registry.snapshot.devices.find((entry) => entry.id === lease.deviceId);
  if (device === undefined) return;
  const opening = await options.inputs.openInput(
    device.spec.platform,
    toDriverDevice(device),
    new AbortController().signal,
  );
  if (!isUnavailableInput(opening)) {
    await opening.close();
    return;
  }
  socket.send(encodeInputMessage(INPUT_TAG.admitted));
  socket.send(encodeInputMessage(INPUT_TAG.config, UNAVAILABLE_INPUT_CONFIG));
}
