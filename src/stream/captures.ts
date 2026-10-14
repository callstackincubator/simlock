// why: a capture belongs to a lease, not to a connection -- the lease is the thing that says this
// machine still owns that simulator, and the types cannot say so. A viewer going away already stops a
// capture through its own request, which covers the ordinary case; this covers the case it cannot, a
// lease that ends somewhere else (released elsewhere, expired, the device lost) while somebody is
// still watching. Without it a stream pins a simulator's framebuffer on a device this worker has
// already handed back.
import type { LeaseEndParticipant } from "../leasing/index.js";

export interface RunningCapture {
  close(): void;
}

export interface CaptureRegistry {
  track(leaseId: string, capture: RunningCapture): RunningCapture;
  stop(leaseId: string): number;
  leases(): string[];
}

export function createCaptureRegistry(): CaptureRegistry {
  const running = new Map<string, Set<RunningCapture>>();

  return {
    leases: () => [...running.keys()],
    stop: (leaseId) => {
      const captures = running.get(leaseId);
      if (captures === undefined) return 0;
      running.delete(leaseId);
      for (const capture of captures) capture.close();
      return captures.size;
    },
    track: (leaseId, capture) => {
      const forLease = running.get(leaseId) ?? new Set<RunningCapture>();
      forLease.add(capture);
      running.set(leaseId, forLease);
      // why: `released` is the handle's own latch, not the capture's -- one capture can be closed
      // through three doors (a stop, an aborted viewer, this registry) and the map must be corrected
      // once, or a second close would remove another lease's capture that had reused the same set.
      let released = false;
      const close = () => {
        if (!released) {
          released = true;
          forLease.delete(capture);
          if (forLease.size === 0) running.delete(leaseId);
        }
        capture.close();
      };
      return { close };
    },
  };
}

export function createStreamLeaseEnd(captures: CaptureRegistry): LeaseEndParticipant {
  return {
    // why: resolves without waiting for the capture process to be reaped. The stop is a closed pipe,
    // not an operation whose outcome leasing needs, and a lease's reclaim must not queue behind a
    // video tool's exit; the viewer learns the picture ended when the tool's stdout reaches its end.
    leaseEnded: async (ended) => {
      captures.stop(ended.leaseId);
    },
  };
}
