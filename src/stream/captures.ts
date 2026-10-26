// why: a capture belongs to the device it films, not to a connection -- the device is the thing that says
// it still runs. A viewer going away stops a capture through its own request; this covers what that
// cannot, a device that stops running or whose lease ends (released elsewhere, expired, the device lost)
// while somebody is still watching, or while a capture is still starting.
import type { ModuleLeaseEndParticipant } from "../modules/index.js";

export interface CaptureSlot {
  // why: aborted when the device stops, so a capture still being opened learns it has nothing to
  // film before it hands a picture out.
  readonly ended: AbortSignal;
  attach(close: () => Promise<void>): void;
  // why: an open that failed has already cleaned up after itself; this settles and forgets the slot
  // with nothing to close.
  abandon(): void;
  // why: the viewer is gone. The slot stays registered until its open settles and what it attached
  // is closed, so a lease that ends meanwhile still waits for the device to be left alone.
  release(): Promise<void>;
  // why: the lease-end reason this slot was stopped with, so its body can end on a frame that says
  // why; absent for a viewer that left or a device that stopped with no lease end.
  endedReason(): string | undefined;
}

export interface CaptureRegistry {
  // why: a device's stream belongs to the device, not to a lease, because a device nobody leases streams
  // too; its captures end when the device stops running or its lease ends, whoever the viewer is.
  beginOnDevice(deviceId: string): CaptureSlot;
  stopOnDevice(deviceId: string, reason?: string): Promise<number>;
}

interface Slot {
  readonly controller: AbortController;
  // why: resolves once the open in progress has either attached a capture or given up, so a lease
  // that ends mid-open waits for the device to be left alone before its reclaim starts.
  readonly settled: Promise<void>;
  settle: () => void;
  close: (() => Promise<void>) | undefined;
  closing: Promise<void> | undefined;
  reason: string | undefined;
}

interface SlotTable {
  begin(key: string): CaptureSlot;
  stop(key: string, reason?: string): Promise<number>;
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

  const forget = (key: string, slot: Slot) => {
    const forKey = running.get(key);
    forKey?.delete(slot);
    if (forKey?.size === 0) running.delete(key);
  };

  return {
    // why: registered before the capture starts, not after its first frame -- a lease that ends in
    // between must find something to stop, or the capture would come up filming a device that is
    // already on its way to the next holder.
    begin: (key) => {
      let settle = () => undefined as void;
      const settled = new Promise<void>((resolve) => (settle = resolve));
      const slot: Slot = {
        close: undefined,
        closing: undefined,
        controller: new AbortController(),
        reason: undefined,
        settle,
        settled,
      };
      const forKey = running.get(key) ?? new Set<Slot>();
      forKey.add(slot);
      running.set(key, forKey);
      return {
        // why: a capture can finish opening after its viewer left or its lease ended; whoever let
        // go of the slot is waiting on `settled`, and closes it the moment it attaches.
        attach: (close) => {
          slot.close = close;
          slot.settle();
        },
        ended: slot.controller.signal,
        endedReason: () => slot.reason,
        abandon: () => {
          slot.settle();
          forget(key, slot);
        },
        release: async () => {
          await closeSlot(slot);
          forget(key, slot);
        },
      };
    },
    stop: async (key, reason) => {
      const forKey = running.get(key);
      if (forKey === undefined) return 0;
      running.delete(key);
      for (const slot of forKey) {
        slot.reason = reason;
        slot.controller.abort();
      }
      await Promise.allSettled([...forKey].map(closeSlot));
      return forKey.size;
    },
  };
}

export function createCaptureRegistry(): CaptureRegistry {
  const devices = createSlotTable();
  return { beginOnDevice: devices.begin, stopOnDevice: devices.stop };
}

export function createStreamLeaseEnd(captures: CaptureRegistry): ModuleLeaseEndParticipant {
  return {
    // why: waits for each capture's close, which a driver bounds, so a reclaim does not wipe or
    // reboot a device while its capture is still being torn down on it; leasing's own signal ends
    // the wait if leasing gives up first.
    leaseEnded: async (ended, signal) => {
      await Promise.race([
        captures.stopOnDevice(ended.deviceId, ended.reason),
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    },
  };
}
