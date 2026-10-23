// why: a capture belongs to the lease or the device it films, not to a connection -- the lease is the thing
// that says this machine still owns that device, and the device is the thing that says it still runs. A
// viewer going away stops a capture through its own request; this covers what that cannot, a lease that
// ends somewhere else (released elsewhere, expired, the device lost) while somebody is still watching, or
// while a capture is still starting.
import type { ModuleLeaseEndParticipant } from "../modules/index.js";

export interface CaptureSlot {
  // why: aborted when the lease ends, so a capture still being opened learns it has no lease to
  // film before it hands a picture out.
  readonly ended: AbortSignal;
  attach(close: () => Promise<void>): void;
  // why: an open that failed has already cleaned up after itself; this settles and forgets the slot
  // with nothing to close.
  abandon(): void;
  // why: the viewer is gone. The slot stays registered until its open settles and what it attached
  // is closed, so a lease that ends meanwhile still waits for the device to be left alone.
  release(): Promise<void>;
}

export interface CaptureRegistry {
  begin(leaseId: string): CaptureSlot;
  stop(leaseId: string): Promise<number>;
  leases(): string[];
  // why: a device's stream belongs to the device, not to a lease, because a device nobody leases streams
  // too; its captures end when the device stops running or its lease ends, whoever the viewer is.
  beginOnDevice(deviceId: string): CaptureSlot;
  stopOnDevice(deviceId: string): Promise<number>;
}

interface Slot {
  readonly controller: AbortController;
  // why: resolves once the open in progress has either attached a capture or given up, so a lease
  // that ends mid-open waits for the device to be left alone before its reclaim starts.
  readonly settled: Promise<void>;
  settle: () => void;
  close: (() => Promise<void>) | undefined;
  closing: Promise<void> | undefined;
}

interface SlotTable {
  begin(key: string): CaptureSlot;
  stop(key: string): Promise<number>;
  keys(): string[];
}

function createSlotTable(): SlotTable {
  const running = new Map<string, Set<Slot>>();

  const closeSlot = async (slot: Slot): Promise<void> => {
    await slot.settled;
    // why: an open that gave up attached nothing and cleaned up after itself; one that attaches
    // after this slot was let go closes from `attach`, so the latch is set only once there is a
    // close to run.
    if (slot.close === undefined) return;
    slot.closing ??= slot.close();
    await slot.closing;
  };

  const forget = (leaseId: string, slot: Slot) => {
    const forLease = running.get(leaseId);
    forLease?.delete(slot);
    if (forLease?.size === 0) running.delete(leaseId);
  };

  return {
    // why: registered before the capture starts, not after its first frame -- a lease that ends in
    // between must find something to stop, or the capture would come up filming a device that is
    // already on its way to the next holder.
    begin: (leaseId) => {
      let settle = () => undefined as void;
      const settled = new Promise<void>((resolve) => (settle = resolve));
      const slot: Slot = {
        close: undefined,
        closing: undefined,
        controller: new AbortController(),
        settle,
        settled,
      };
      const forLease = running.get(leaseId) ?? new Set<Slot>();
      forLease.add(slot);
      running.set(leaseId, forLease);
      return {
        // why: a capture can finish opening after its viewer left or its lease ended; whoever let
        // go of the slot is waiting on `settled`, and closes it the moment it attaches.
        attach: (close) => {
          slot.close = close;
          slot.settle();
        },
        ended: slot.controller.signal,
        abandon: () => {
          slot.settle();
          forget(leaseId, slot);
        },
        release: async () => {
          await closeSlot(slot);
          forget(leaseId, slot);
        },
      };
    },
    keys: () => [...running.keys()],
    stop: async (leaseId) => {
      const forLease = running.get(leaseId);
      if (forLease === undefined) return 0;
      running.delete(leaseId);
      for (const slot of forLease) slot.controller.abort();
      await Promise.allSettled([...forLease].map(closeSlot));
      return forLease.size;
    },
  };
}

export function createCaptureRegistry(): CaptureRegistry {
  const leases = createSlotTable();
  const devices = createSlotTable();
  return {
    begin: leases.begin,
    beginOnDevice: devices.begin,
    leases: leases.keys,
    stop: leases.stop,
    stopOnDevice: devices.stop,
  };
}

export function createStreamLeaseEnd(captures: CaptureRegistry): ModuleLeaseEndParticipant {
  return {
    // why: waits for each capture's close, which a driver bounds, so a reclaim does not wipe or
    // reboot a device while its capture is still being torn down on it; leasing's own signal ends
    // the wait if leasing gives up first.
    leaseEnded: async (ended, signal) => {
      await Promise.race([
        Promise.all([captures.stop(ended.leaseId), captures.stopOnDevice(ended.deviceId)]),
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    },
  };
}
