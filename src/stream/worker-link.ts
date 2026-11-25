import { readsEveryLease } from "../contract/index.js";
import {
  type DeviceRecord,
  encodeScreenFrame,
  SCREEN_FRAME_TAG,
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
import { type Broadcast, createBroadcast } from "./broadcast.js";
import type { CaptureRegistry, CaptureSlot } from "./captures.js";
import type { StreamCaller } from "./caller.js";
import { type CapturedStream, type FeedBounds, readScreenFeed } from "./feed.js";
import {
  deviceNotRunning,
  deviceStopped,
  notStreamable,
  StreamRefusalError,
  streamUnavailable,
  unknownDevice,
  unknownLease,
  unknownWorker,
} from "./refusal.js";
import type { StreamLink, StreamTarget } from "./service.js";

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
  readonly instanceId: string;
  readonly registry: StreamRegistry;
  readonly screens: ScreenOpener;
  readonly captures: CaptureRegistry;
  readonly settings: ScreenSettings;
  readonly bounds: FeedBounds;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (stream: CapturedStream) => void;
  readonly reject: (error: unknown) => void;
}

// why: a device's capture, from the moment the first viewer asks for it until its last viewer leaves
// or it ends. Viewers that ask while it is still starting wait on it as a group.
interface SharedCapture {
  readonly slot: CaptureSlot;
  readonly abort: AbortController;
  readonly waiters: Waiter[];
  broadcast: Broadcast | undefined;
}

export function createWorkerStreamLink(options: WorkerStreamLinkOptions): StreamLink {
  const shared = new Map<string, SharedCapture>();

  const start = (device: DeviceRecord): SharedCapture => {
    const entry: SharedCapture = {
      abort: new AbortController(),
      broadcast: undefined,
      slot: options.captures.beginOnDevice(device.id),
      waiters: [],
    };
    shared.set(device.id, entry);
    const forget = () => {
      if (shared.get(device.id) === entry) shared.delete(device.id);
    };
    void open(options, device, entry).then(
      async (stream) => {
        const waiters = entry.waiters.splice(0);
        const viewers = waiters.filter((waiter) => !waiter.signal.aborted);
        if (viewers.length > 0) {
          const broadcast = createBroadcast(stream);
          entry.broadcast = broadcast;
          void broadcast.done.then(() => {
            forget();
            return entry.slot.release();
          });
          for (const waiter of viewers) waiter.resolve(broadcast.join(waiter.signal));
        } else {
          forget();
          void stream.body.cancel().catch(() => undefined);
          await entry.slot.release();
        }
        for (const waiter of waiters) {
          if (waiter.signal.aborted) waiter.reject(viewerGone());
        }
      },
      (error: unknown) => {
        forget();
        for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
      },
    );
    return entry;
  };

  return {
    async serve(target, caller, signal): Promise<CapturedStream> {
      // why: the caller and the device are checked before anything is asked of the machine. A link that
      // looked for its capture first would answer an agent one way for a device this worker has and
      // another for one it does not, which is a way of listing the fleet's devices.
      const device = requireDevice(options, target, caller);
      let entry = shared.get(device.id);
      // why: a capture whose slot was stopped, or whose broadcast stopped because its last viewer left or
      // its source ended, is going away until its close settles, so a viewer that asks now gets a fresh
      // one rather than the end of the old.
      if (entry?.slot.ended.aborted === true || entry?.broadcast?.stopped === true)
        entry = undefined;
      entry ??= start(device);
      if (entry.broadcast !== undefined) return entry.broadcast.join(signal);
      return await new Promise<CapturedStream>((resolve, reject) => {
        const waiter: Waiter = { reject, resolve, signal };
        const pending = entry;
        pending.waiters.push(waiter);
        const leave = () => {
          // why: the last viewer to leave a capture that is still starting stops it, as a lone viewer
          // does today; what the open attached is closed once it settles, and every viewer is answered
          // then.
          // why: once the open has settled the waiters are gone and the broadcast owns its viewers.
          if (pending.waiters.length === 0) return;
          if (!pending.waiters.every((other) => other.signal.aborted)) return;
          pending.abort.abort();
          if (shared.get(device.id) === pending) shared.delete(device.id);
          void pending.slot.release();
        };
        if (signal.aborted) leave();
        else signal.addEventListener("abort", leave, { once: true });
      });
    },
  };
}

async function open(
  options: WorkerStreamLinkOptions,
  device: DeviceRecord,
  entry: SharedCapture,
): Promise<CapturedStream> {
  const { slot } = entry;
  let stream: CapturedStream;
  try {
    const feed = closedOnce(
      await options.screens.openScreen(
        device.spec.platform,
        toDriverDevice(device),
        options.settings,
        AbortSignal.any([entry.abort.signal, slot.ended]),
      ),
    );
    slot.attach(feed.close);
    stream = await readScreenFeed(feed, options.bounds, () => endedFrame(slot.endedReason()));
  } catch (error) {
    slot.abandon();
    if (slot.ended.aborted) throw deviceStopped();
    throw refusalFor(error);
  }
  // why: a capture can take seconds to start and the device can stop meanwhile; a slot that was
  // stopped says so, so the viewer is refused rather than handed a picture of a device that is gone.
  if (slot.ended.aborted) {
    await slot.release();
    throw deviceStopped();
  }
  return stream;
}

// why: the feed's reader, the viewer and the device's end can each close a capture, and a driver's
// close stops processes on a device; it runs once, and every later caller waits on the same stop.
function closedOnce(feed: ScreenFeed): ScreenFeed {
  let closing: Promise<void> | undefined;
  return { body: feed.body, close: () => (closing ??= feed.close()) };
}

function viewerGone(): StreamRefusalError {
  return streamUnavailable("The viewer went away before the picture started");
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
  // why: only an operator or viewer watches a device, and an agent gets the answer an unknown device gets, so
  // it cannot learn which devices exist or which one its lease holds. A lease's stream was checked
  // against its owner by the HTTP layer before it got here.
  if (target.leaseId === undefined && !readsEveryLease(caller.role)) {
    throw unknownDevice(target.deviceId);
  }
  // why: a worker answers only for its own id (ADR 0012 section 1); a gateway names the worker it relays to,
  // and a request that reaches the wrong worker is refused rather than answered with the wrong screen.
  if (target.workerId !== undefined && target.workerId !== options.instanceId) {
    throw unknownWorker(target.workerId);
  }
  const deviceId =
    target.leaseId === undefined ? target.deviceId : leasedDeviceId(options, target.leaseId);
  const device = options.registry.snapshot.devices.find((candidate) => candidate.id === deviceId);
  if (device === undefined) throw unknownDevice(deviceId);
  if (device.state !== "ready" && device.state !== "leased") throw deviceNotRunning(device.state);
  return device;
}

// why: the worker's own record is the truth for a lease a caller names; a lease that is gone from it
// is unknown whoever asks, as `lease.get` answers.
function leasedDeviceId(options: WorkerStreamLinkOptions, leaseId: string): string {
  const lease = options.registry.snapshot.leases.find((candidate) => candidate.id === leaseId);
  if (lease === undefined) throw unknownLease(leaseId);
  return lease.deviceId;
}

function endedFrame(reason: string | undefined): Uint8Array | undefined {
  if (reason === undefined) return undefined;
  return encodeScreenFrame(
    SCREEN_FRAME_TAG.ended,
    new TextEncoder().encode(JSON.stringify({ reason })),
  );
}
