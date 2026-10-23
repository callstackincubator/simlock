import {
  type DeviceRecord,
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
import {
  deviceNotRunning,
  deviceStopped,
  notStreamable,
  StreamRefusalError,
  streamUnavailable,
  unknownDevice,
  unknownWorker,
} from "./refusal.js";
import type { StreamLink, StreamTarget } from "./service.js";

export interface StreamRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
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
  readonly instanceId: string;
  readonly registry: StreamRegistry;
  readonly screens: ScreenOpener;
  readonly captures: CaptureRegistry;
  readonly settings: ScreenSettings;
  readonly bounds: FeedBounds;
}

export function createWorkerStreamLink(options: WorkerStreamLinkOptions): StreamLink {
  return {
    async serve(target, caller, signal): Promise<CapturedStream> {
      // why: the caller and the device are checked before anything is asked of the machine. A link that
      // looked for its capture first would answer an agent one way for a device this worker has and
      // another for one it does not, which is a way of listing the fleet's devices.
      const device = requireDevice(options, target, caller);
      const slot = options.captures.beginOnDevice(device.id);
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
        if (slot.ended.aborted) throw deviceStopped();
        throw refusalFor(error);
      }
      // why: a capture can take seconds to start and the device can stop meanwhile; a slot that was
      // stopped says so, so the viewer is refused rather than handed a picture of a device that is gone.
      if (signal.aborted) {
        await slot.release();
        throw streamUnavailable("The viewer went away before the picture started");
      }
      if (slot.ended.aborted) {
        await slot.release();
        throw deviceStopped();
      }
      return { ...stream, close: () => slot.release() };
    },
  };
}

// why: the feed's reader, the viewer and the device's end can each close a capture, and a driver's
// close stops processes on a device; it runs once, and every later caller waits on the same stop.
function closedOnce(feed: ScreenFeed): ScreenFeed {
  let closing: Promise<void> | undefined;
  return { body: feed.body, close: () => (closing ??= feed.close()) };
}

function refusalFor(error: unknown): StreamRefusalError {
  if (error instanceof StreamRefusalError) return error;
  if (error instanceof ScreenNotSupportedError) return notStreamable(error.message);
  // why: a capture that failed before its first frame is a picture that is not available right now
  // rather than a broken request -- the device is fine and a retry needs no different ask.
  if (error instanceof ScreenUnavailableError || error instanceof Error) {
    return streamUnavailable(error.message);
  }
  return streamUnavailable(String(error));
}

function requireDevice(
  options: WorkerStreamLinkOptions,
  target: StreamTarget,
  caller: StreamCaller,
): DeviceRecord {
  // why: only an operator watches a device, and an agent gets the answer an unknown device gets, so
  // it cannot learn which devices exist or which one its lease holds.
  if (caller.role !== "operator") throw unknownDevice(target.deviceId);
  // why: a worker answers only for its own id (ADR 0012 section 1); a gateway names the worker it relays to,
  // and a request that reaches the wrong worker is refused rather than answered with the wrong screen.
  if (target.workerId !== undefined && target.workerId !== options.instanceId) {
    throw unknownWorker(target.workerId);
  }
  const device = options.registry.snapshot.devices.find(
    (candidate) => candidate.id === target.deviceId,
  );
  if (device === undefined) throw unknownDevice(target.deviceId);
  if (device.state !== "ready" && device.state !== "leased") throw deviceNotRunning(device.state);
  return device;
}
