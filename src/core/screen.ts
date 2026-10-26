import type { PhysicalDriverDevice, VirtualDriverDevice } from "./driver.js";

// why: the one table in TypeScript for a capture's bytes: the Android driver writes it and the stream
// module reads it. The Swift capture program, the console and the e2e tests keep their own copies;
// the console's test pins its copy to this one, so a tag that drifts fails a test instead of a viewer
// decoding garbage.
export const SCREEN_FRAME_TAG = {
  description: 0x01,
  keyframe: 0x02,
  delta: 0x03,
  seed: 0x04,
  meta: 0x05,
  // why: an empty frame a capture sends when it is alive with nothing new to paint, so a reader's
  // silence bound tells a still screen from a dead capture; a reader that has no use for it skips it.
  alive: 0x06,
  // why: the last frame of a stream a lease end stopped, carrying JSON `{"reason"}`: why the picture ended.
  ended: 0x07,
} as const;

export const SCREEN_FRAME_HEADER_BYTES = 5;

export interface ScreenMeta {
  readonly codec: "h264" | "mjpeg";
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export interface ScreenSettings {
  readonly fps: number;
  readonly maxDimension: number;
  readonly bitrateKbps: number;
}

// why: the one shape every platform's capture is handed out in, so the module that serves a stream
// never learns how a picture was taken. `body` carries frames in the table above, meta first; the
// stream module, not the driver, decides how long it may stay quiet.
export interface ScreenFeed {
  readonly body: ReadableStream<Uint8Array>;
  // why: resolves once the device holds nothing of this capture any more -- a server process, a
  // forward, a pushed file -- so a lease's reclaim can wait for it rather than race it. Bounded by
  // the driver and idempotent: a viewer leaving, the lease ending and the body ending all call it.
  close(): Promise<void>;
}

export interface ScreenCapture {
  // why: a reason when this driver cannot capture right now (its program is missing), so a
  // status read can say why without opening a stream to find out.
  unavailable(): Promise<string | undefined>;
  // why: `signal` aborts an open still in progress -- the viewer left or the lease ended -- so a
  // driver stops pushing files to and starting processes on a device that is being handed back.
  open(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    settings: ScreenSettings,
    signal: AbortSignal,
  ): Promise<ScreenFeed>;
}

export class ScreenNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenNotSupportedError";
  }
}

export class ScreenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenUnavailableError";
  }
}

export function encodeScreenFrame(tag: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(SCREEN_FRAME_HEADER_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1);
  frame[4] = tag;
  frame.set(payload, SCREEN_FRAME_HEADER_BYTES);
  return frame;
}

export function encodeScreenMeta(meta: ScreenMeta): Uint8Array {
  return encodeScreenFrame(SCREEN_FRAME_TAG.meta, new TextEncoder().encode(JSON.stringify(meta)));
}
