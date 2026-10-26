import {
  encodeInputMessage,
  INPUT_TAG,
  isUnavailableInput,
  parseClientMessage,
  toDriverDevice,
  UNAVAILABLE_INPUT_CONFIG,
  type DeviceInput,
  type DeviceRecord,
  type InputScreenConfig,
  type UnavailableDeviceInput,
} from "../core/index.js";
import type { ModuleInputs } from "../modules/index.js";
import type { LeaseSocket } from "../ports/index.js";

interface Attached {
  readonly socket: LeaseSocket;
  admitted: boolean;
}

// why: one device input per lease, shared by every socket of it, so two people on one lease do not
// start two controllers on one device.
interface LeaseInput {
  readonly opening: Promise<DeviceInput | UnavailableDeviceInput>;
  readonly sockets: Set<Attached>;
  config: InputScreenConfig | undefined;
}

export interface InputSessions {
  attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void;
}

export function createInputSessions(options: { readonly inputs: ModuleInputs }): InputSessions {
  const leases = new Map<string, LeaseInput>();

  function openFor(leaseId: string, device: DeviceRecord): LeaseInput {
    const existing = leases.get(leaseId);
    if (existing !== undefined) return existing;
    const sockets = new Set<Attached>();
    const entry: LeaseInput = {
      config: undefined,
      opening: options.inputs
        .openInput(device.spec.platform, toDriverDevice(device), new AbortController().signal)
        .then((opened) => {
          if (!isUnavailableInput(opened)) {
            opened.onConfig((config) => {
              entry.config = config;
              for (const attached of sockets) {
                if (attached.admitted)
                  attached.socket.send(encodeInputMessage(INPUT_TAG.config, config));
              }
            });
          }
          return opened;
        }),
      sockets,
    };
    leases.set(leaseId, entry);
    return entry;
  }

  async function attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): Promise<void> {
    const entry = openFor(leaseId, device);
    const attached: Attached = { admitted: false, socket };
    entry.sockets.add(attached);
    socket.onClose(() => {
      entry.sockets.delete(attached);
      if (entry.sockets.size > 0) return;
      leases.delete(leaseId);
      void entry.opening.then((opened) =>
        isUnavailableInput(opened) ? undefined : opened.close(),
      );
    });
    const opened = await entry.opening;
    socket.send(encodeInputMessage(INPUT_TAG.admitted));
    if (isUnavailableInput(opened)) {
      socket.send(encodeInputMessage(INPUT_TAG.config, UNAVAILABLE_INPUT_CONFIG));
      return;
    }
    attached.admitted = true;
    if (entry.config !== undefined) socket.send(encodeInputMessage(INPUT_TAG.config, entry.config));
    socket.onMessage((data) => {
      const message = parseClientMessage(data);
      if (message === undefined) return;
      if (message.kind === "control") {
        socket.send(
          encodeInputMessage(INPUT_TAG.controlResult, {
            error: "This device cannot change its pose",
            ok: false,
            ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
          }),
        );
        return;
      }
      opened.send(message);
    });
  }

  return { attach: (leaseId, device, socket) => void attach(leaseId, device, socket) };
}
