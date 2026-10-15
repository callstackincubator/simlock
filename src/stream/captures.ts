// why: a capture belongs to a lease, not to a connection -- the lease is the thing that says this
// machine still owns that device. A viewer going away stops a capture through its own request; this
// covers what that cannot, a lease that ends somewhere else (released elsewhere, expired, the device
// lost) while somebody is still watching, or while a capture is still starting.
import type { LeaseEndParticipant } from "../leasing/index.js";

export interface CaptureSlot {
  // why: aborted when the lease ends, so a capture still being opened learns it has no lease to
  // film before it hands a picture out.
  readonly ended: AbortSignal;
  attach(close: () => Promise<void>): void;
  release(): Promise<void>;
}

export interface CaptureRegistry {
  begin(leaseId: string): CaptureSlot;
  stop(leaseId: string): Promise<number>;
  leases(): string[];
}

interface Slot {
  readonly controller: AbortController;
  close: (() => Promise<void>) | undefined;
  closing: Promise<void> | undefined;
}

export function createCaptureRegistry(): CaptureRegistry {
  const running = new Map<string, Set<Slot>>();

  const closeSlot = (slot: Slot): Promise<void> => {
    // why: a slot stopped before its capture attached has nothing to close yet; `attach` closes it
    // then, so the latch is set only once there is a close to run.
    if (slot.close === undefined) return Promise.resolve();
    slot.closing ??= slot.close();
    return slot.closing;
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
      const slot: Slot = {
        close: undefined,
        closing: undefined,
        controller: new AbortController(),
      };
      const forLease = running.get(leaseId) ?? new Set<Slot>();
      forLease.add(slot);
      running.set(leaseId, forLease);
      return {
        attach: (close) => {
          slot.close = close;
          if (slot.controller.signal.aborted) void closeSlot(slot);
        },
        ended: slot.controller.signal,
        release: async () => {
          forget(leaseId, slot);
          await closeSlot(slot);
        },
      };
    },
    leases: () => [...running.keys()],
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

export function createStreamLeaseEnd(captures: CaptureRegistry): LeaseEndParticipant {
  return {
    // why: waits for each capture's close, which a driver bounds, so a reclaim does not wipe or
    // reboot a device while its capture is still being torn down on it; leasing's own signal ends
    // the wait if leasing gives up first.
    leaseEnded: async (ended, signal) => {
      await Promise.race([
        captures.stop(ended.leaseId),
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    },
  };
}
