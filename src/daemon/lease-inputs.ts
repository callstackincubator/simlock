import {
  isUnavailableInput,
  type DeviceInput,
  type PhysicalDriverDevice,
  type UnavailableDeviceInput,
  type VirtualDriverDevice,
} from "../core/index.js";
import type { ModuleInputs, ModuleLeaseEndParticipant } from "../modules/index.js";
import type { Platform } from "../core/index.js";

interface Entry {
  readonly opening: Promise<DeviceInput | UnavailableDeviceInput>;
  users: number;
  closed: boolean;
}

export interface LeaseInputs extends ModuleInputs {
  readonly leaseEnd: ModuleLeaseEndParticipant;
}

/**
 * why: ADR 0053 §1-6: the daemon keeps one device input per lease, shared by the input module's sockets and `device.rotate`, so two users of one lease never start two controllers on one device. The last user to release closes it; a failure or the lease's end drops it, and the next user opens a fresh one.
 */
export function createLeaseInputs(options: {
  readonly openInput: (
    platform: Platform,
    device: VirtualDriverDevice | PhysicalDriverDevice,
    signal: AbortSignal,
  ) => Promise<DeviceInput | UnavailableDeviceInput>;
}): LeaseInputs {
  const entries = new Map<string, Entry>();

  // why: every end of a lease's input -- the last release, its failure, the lease's end -- goes through here, so it closes once, and an input still opening closes when it has opened.
  function close(leaseId: string, entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entries.get(leaseId) === entry) entries.delete(leaseId);
    void entry.opening
      .then((opened) => (isUnavailableInput(opened) ? undefined : opened.close()))
      .catch(() => undefined);
  }

  function create(
    leaseId: string,
    platform: Platform,
    device: VirtualDriverDevice | PhysicalDriverDevice,
  ): Entry {
    const entry: Entry = {
      closed: false,
      opening: options.openInput(platform, device, new AbortController().signal).then(
        (opened) => {
          if (isUnavailableInput(opened)) {
            if (entries.get(leaseId) === entry) entries.delete(leaseId);
          } else {
            opened.onFailed(() => close(leaseId, entry));
          }
          return opened;
        },
        (error: unknown) => {
          if (entries.get(leaseId) === entry) entries.delete(leaseId);
          throw error;
        },
      ),
      users: 0,
    };
    entries.set(leaseId, entry);
    return entry;
  }

  return {
    leaseEnd: {
      leaseEnded: (ended) => {
        const entry = entries.get(ended.leaseId);
        if (entry !== undefined) close(ended.leaseId, entry);
        return Promise.resolve();
      },
    },
    leaseInput: async (leaseId, platform, device) => {
      const entry = entries.get(leaseId) ?? create(leaseId, platform, device);
      entry.users += 1;
      let input: DeviceInput | UnavailableDeviceInput;
      try {
        input = await entry.opening;
      } catch (error) {
        entry.users -= 1;
        throw error;
      }
      let released = false;
      return {
        input,
        release: () => {
          if (released) return;
          released = true;
          entry.users -= 1;
          if (entry.users === 0) close(leaseId, entry);
        },
      };
    },
  };
}
