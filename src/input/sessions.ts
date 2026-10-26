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
import type { Clock, LeaseSocket } from "../ports/index.js";

const MAX_SOCKETS_PER_LEASE = 8;
// why: a device input that failed to open is not tried again for this long, so a client that
// reconnects every second does not start a controller on a broken device every second.
const FAILED_OPEN_MEMORY_MS = 10_000;
const CLOSE_FAILED = 1013;
const CLOSE_LEASE_ENDED = 4001;
const CLOSE_GOING_AWAY = 1001;
const REASON_FAILED = "Input is unavailable for this lease";

interface Attached {
  readonly socket: LeaseSocket;
  admitted: boolean;
}

// why: one device input per lease, shared by every socket of it, so two people on one lease do not
// start two controllers on one device.
interface LeaseInput {
  // why: set once the device input has opened, so an end that finds it open closes it at once instead of after a wait.
  device: DeviceInput | undefined;
  readonly opening: Promise<DeviceInput | UnavailableDeviceInput>;
  readonly sockets: Set<Attached>;
  config: InputScreenConfig | undefined;
  closed: boolean;
}

export interface InputSessions {
  attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void;
  end(leaseId: string, reason: string): void;
  drain(): void;
}

export function createInputSessions(options: {
  readonly inputs: ModuleInputs;
  readonly clock: Clock;
  readonly leaseExists: (leaseId: string) => boolean;
}): InputSessions {
  const leases = new Map<string, LeaseInput>();
  const failedOpens = new Map<string, number>();

  // why: every end of a lease's device input -- its last socket leaving, its own failure -- goes through here, so it closes once.
  function release(leaseId: string, entry: LeaseInput, opened: DeviceInput): void {
    if (entry.closed) return;
    entry.closed = true;
    if (leases.get(leaseId) === entry) leases.delete(leaseId);
    void opened.close();
  }

  // why: an unavailable device input has nothing to close, so its entry is dropped at once instead of staying for the daemon's lifetime.
  function forget(leaseId: string, entry: LeaseInput): void {
    if (leases.get(leaseId) === entry) leases.delete(leaseId);
  }

  // why: `unlessJoined` is the last socket leaving: a socket that joined while the input was still opening keeps it, so the close that waited for the open drops out.
  function releaseWhenOpen(leaseId: string, entry: LeaseInput, unlessJoined = false): void {
    if (entry.device !== undefined) {
      release(leaseId, entry, entry.device);
      return;
    }
    void entry.opening.then(
      (opened) => {
        if (unlessJoined && entry.sockets.size > 0) return;
        if (isUnavailableInput(opened)) forget(leaseId, entry);
        else release(leaseId, entry, opened);
      },
      () => undefined,
    );
  }

  function end(leaseId: string, reason: string): void {
    failedOpens.delete(leaseId);
    const entry = leases.get(leaseId);
    if (entry === undefined) return;
    for (const attached of entry.sockets) attached.socket.close(CLOSE_LEASE_ENDED, reason);
    releaseWhenOpen(leaseId, entry);
  }

  function drain(): void {
    for (const [leaseId, entry] of leases) {
      for (const attached of entry.sockets)
        attached.socket.close(CLOSE_GOING_AWAY, "Simlock is stopping");
      releaseWhenOpen(leaseId, entry);
    }
  }

  function openFor(leaseId: string, device: DeviceRecord): LeaseInput {
    const existing = leases.get(leaseId);
    if (existing !== undefined) return existing;
    const sockets = new Set<Attached>();
    const entry: LeaseInput = {
      closed: false,
      config: undefined,
      device: undefined,
      opening: options.inputs
        .openInput(device.spec.platform, toDriverDevice(device), new AbortController().signal)
        .then(
          (opened) => {
            if (!isUnavailableInput(opened)) {
              entry.device = opened;
              wire(leaseId, entry, opened);
            }
            return opened;
          },
          (error: unknown) => {
            failedOpens.set(leaseId, options.clock.now());
            if (leases.get(leaseId) === entry) leases.delete(leaseId);
            throw error;
          },
        ),
      sockets,
    };
    leases.set(leaseId, entry);
    return entry;
  }

  function wire(leaseId: string, entry: LeaseInput, opened: DeviceInput): void {
    opened.onConfig((config) => {
      entry.config = config;
      for (const attached of entry.sockets) {
        if (attached.admitted) attached.socket.send(encodeInputMessage(INPUT_TAG.config, config));
      }
    });
    opened.onFailed(() => {
      release(leaseId, entry, opened);
      for (const attached of entry.sockets) attached.socket.close(CLOSE_FAILED, REASON_FAILED);
    });
  }

  async function attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): Promise<void> {
    // why: the lease can end between the HTTP layer's check and this socket's upgrade; the worker's own record decides.
    if (!options.leaseExists(leaseId)) {
      socket.close(CLOSE_LEASE_ENDED, "lease ended");
      return;
    }
    const failedAt = failedOpens.get(leaseId);
    if (failedAt !== undefined && options.clock.now() - failedAt < FAILED_OPEN_MEMORY_MS) {
      socket.close(CLOSE_FAILED, REASON_FAILED);
      return;
    }
    if ((leases.get(leaseId)?.sockets.size ?? 0) >= MAX_SOCKETS_PER_LEASE) {
      socket.close(CLOSE_FAILED, REASON_FAILED);
      return;
    }
    const entry = openFor(leaseId, device);
    const attached: Attached = { admitted: false, socket };
    entry.sockets.add(attached);
    socket.onClose(() => {
      entry.sockets.delete(attached);
      if (entry.sockets.size === 0) releaseWhenOpen(leaseId, entry, true);
    });
    let opened: DeviceInput | UnavailableDeviceInput;
    try {
      opened = await entry.opening;
    } catch {
      socket.close(CLOSE_FAILED, REASON_FAILED);
      return;
    }
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

  return {
    attach: (leaseId, device, socket) => void attach(leaseId, device, socket),
    drain,
    end,
  };
}
