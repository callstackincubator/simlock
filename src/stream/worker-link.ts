import {
  type DeviceRecord,
  type LeaseRecord,
  type Platform,
  type PhysicalDriverDevice,
  type ScreenFeed,
  ScreenNotSupportedError,
  type ScreenSettings,
  ScreenUnavailableError,
  toDriverDevice,
  type VirtualDriverDevice,
} from "../core/index.js";
import type { CaptureRegistry } from "./captures.js";
import type { StreamCaller } from "./caller.js";
import { type CapturedStream, type FeedBounds, readScreenFeed } from "./feed.js";
import { notStreamable, StreamRefusalError, streamUnavailable, unknownLease } from "./refusal.js";
import type { StreamLink } from "./service.js";

export interface StreamRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface ScreenOpener {
  openScreen(
    platform: Platform,
    device: VirtualDriverDevice | PhysicalDriverDevice,
    settings: ScreenSettings,
    signal: AbortSignal,
  ): Promise<ScreenFeed>;
}

export interface WorkerStreamLinkOptions {
  readonly registry: StreamRegistry;
  readonly screens: ScreenOpener;
  readonly captures: CaptureRegistry;
  readonly settings: ScreenSettings;
  readonly bounds: FeedBounds;
}

export function createWorkerStreamLink(options: WorkerStreamLinkOptions): StreamLink {
  return {
    async serve(leaseId, caller, signal): Promise<CapturedStream> {
      // why: ownership is proved before anything is asked of the machine. A link that looked for its
      // capture first would answer an agent one way for a lease this worker holds and another for a
      // lease that does not exist, which is a way of listing the fleet's leases.
      const { device, lease } = requireLease(options.registry, leaseId, caller);
      const slot = options.captures.begin(leaseId);
      // why: the listener, and not only the body's cancel, because a request aborted before its
      // first frame has no body being read yet -- which is what a page opened and closed quickly does.
      if (signal.aborted) void slot.release();
      else signal.addEventListener("abort", () => void slot.release(), { once: true });

      let stream: CapturedStream;
      try {
        const feed = closedOnce(
          await options.screens.openScreen(
            device.spec.platform,
            toDriverDevice(device),
            options.settings,
            AbortSignal.any([signal, slot.ended]),
          ),
        );
        slot.attach(feed.close);
        stream = await readScreenFeed(feed, options.bounds);
      } catch (error) {
        slot.abandon();
        if (slot.ended.aborted) throw unknownLease(leaseId);
        throw refusalFor(error);
      }
      // why: the lease is read again once there is a picture, because a capture can take seconds to
      // start and the lease it was asked for can end and the device be granted to someone else in
      // that time; a slot that was stopped says so even if a new lease reused the id.
      const still = options.registry.snapshot.leases.find((candidate) => candidate.id === leaseId);
      if (signal.aborted) {
        await slot.release();
        throw streamUnavailable("The viewer went away before the picture started");
      }
      if (slot.ended.aborted || still?.deviceId !== lease.deviceId) {
        await slot.release();
        throw unknownLease(leaseId);
      }
      return { ...stream, close: () => slot.release() };
    },
  };
}

// why: the feed's reader, the viewer and the lease's end can each close a capture, and a driver's
// close stops processes on a device; it runs once, and every later caller waits on the same stop.
function closedOnce(feed: ScreenFeed): ScreenFeed {
  let closing: Promise<void> | undefined;
  return { body: feed.body, close: () => (closing ??= feed.close()) };
}

function refusalFor(error: unknown): StreamRefusalError {
  if (error instanceof StreamRefusalError) return error;
  if (error instanceof ScreenNotSupportedError) return notStreamable(error.message);
  // why: a capture that failed before its first frame is a picture that is not available right now
  // rather than a broken request -- the lease is fine and a retry needs no different ask.
  if (error instanceof ScreenUnavailableError || error instanceof Error) {
    return streamUnavailable(error.message);
  }
  return streamUnavailable(String(error));
}

// why: ownership is proved against this worker's own registry rather than taken from whoever relayed
// the request. A caller that names a requester is checked against the lease's requester (the rule
// `device.exec` follows); one that names none is checked against the principal that owns the lease.
// An unknown lease and one held by someone else get the same answer, because an agent must not be
// able to discover which leases exist by asking for pictures of them.
function requireLease(
  registry: StreamRegistry,
  leaseId: string,
  caller: StreamCaller,
): { readonly lease: LeaseRecord; readonly device: DeviceRecord } {
  const snapshot = registry.snapshot;
  const lease = snapshot.leases.find((candidate) => candidate.id === leaseId);
  if (lease === undefined) throw unknownLease(leaseId);
  if (caller.role !== "operator") {
    const held =
      caller.requesterId === undefined
        ? lease.ownerId === caller.principal
        : lease.requesterId === caller.requesterId;
    if (!held) throw unknownLease(leaseId);
  }
  const device = snapshot.devices.find((candidate) => candidate.id === lease.deviceId);
  if (device === undefined) throw unknownLease(leaseId);
  return { device, lease };
}
