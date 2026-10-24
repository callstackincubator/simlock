/**
 * why: nothing controls a device's picture but the panel that shows it, because this surface has no
 * command of its own to send — the request *is* the on command and aborting it *is* the off one. So
 * the pane's lifecycle is the capture's lifecycle: leaving the tab, closing the drawer, navigating
 * away and signing out are four ways of doing the same single thing, and a capture cannot outlive the
 * pane that asked for it. That is also why nothing here polls, retries, or holds a stream open across
 * a navigation.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../data/api";
import { readStream, type StreamMeta, type StreamStats } from "../data/stream";
import {
  deviceScreen,
  type Readout,
  type ScreenPhase,
  screenView,
  type StreamOffer,
  streamsDevice,
} from "../model/screen";
import { useApi } from "./services";

export type { Readout, StreamOffer } from "../model/screen";

const EMPTY: StreamStats = {
  dropped: 0,
  error: undefined,
  fed: 0,
  framesPerSecond: 0,
  kilobitsPerSecond: 0,
  painted: 0,
};

// why: a worker answers a stream's headers only once its capture wrote its first frame, and it may
// take about 185 s on a physical Android phone (the shared adb server's version check up to 45 s
// the first time and 5 s before each later step, the screen read 20 s, the wake 20 s, the second
// read 20 s, the push 40 s, the server 15 s and a last check of up to 5 s past it); an emulator's
// worst case is 75 s (its push 30 s, its server 15 s, the first frame 30 s). A console that gave up
// sooner would show its own timeout instead of the worker's reason.
export const STREAM_HEAD_TIMEOUT_MS = 200_000;

export interface Screen {
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly width: number;
  readonly height: number;
  readonly live: boolean;
  readonly waiting: string | undefined;
  readonly readout: Readout;
  readonly note: string | undefined;
  // why: the daemon's 409 message, kept apart from `note` because the panel words it with the device's
  // state and the row may be about to say the same.
  readonly conflict: string | undefined;
}

export type DeviceScreenView =
  | { readonly kind: "picture"; readonly screen: Screen }
  | { readonly kind: "sentence"; readonly text: string };

// why: the tab shows the picture only for a device the daemon streams, and says in words why it
// shows none for any other, so the decision sits here and the panel only draws.
export function useDeviceScreen(
  workerId: string,
  deviceId: string,
  state: string,
  offer: StreamOffer,
): DeviceScreenView {
  const screen = useScreen(workerId, deviceId, streamsDevice(state, offer));
  const shown = deviceScreen({ conflict: screen.conflict, offer, state });
  return shown.kind === "picture" ? { kind: "picture", screen } : shown;
}

function useScreen(workerId: string, deviceId: string, enabled: boolean): Screen {
  const api = useApi();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const [phase, setPhase] = useState<ScreenPhase>("idle");
  const [meta, setMeta] = useState<StreamMeta | undefined>(undefined);
  const [stats, setStats] = useState<StreamStats>(EMPTY);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<string | undefined>(undefined);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
    setPhase("stopped");
  }, []);

  const start = useCallback(() => {
    const abort = new AbortController();
    controller.current = abort;
    setNote(undefined);
    setConflict(undefined);
    setMeta(undefined);
    setStats(EMPTY);
    setPhase("starting");
    void capture(api, workerId, deviceId, abort.signal, {
      canvas,
      conflict: (message) => {
        setConflict(message);
        setPhase("stopped");
      },
      ended: (reason) => {
        setNote(reason);
        setPhase("stopped");
      },
      live: () => setPhase("live"),
      setMeta,
      setStats,
    });
  }, [api, workerId, deviceId]);

  // why: the picture starts when the panel is drawn and stops when it is not, so leaving the tab,
  // closing the drawer and navigating away are one event and a capture cannot outlive its viewer.
  // A change of the device's state between two that stream does not change `enabled`, so it asks
  // for nothing again; one that stops and then allows streaming does.
  useEffect(() => {
    if (!enabled) return undefined;
    start();
    return stop;
  }, [enabled, start, stop]);

  return { canvas, conflict, ...screenView({ meta, note, phase, stats }) };
}

/**
 * why: the daemon names its reason in its own words and those words reach the reader, because they
 * say what its operator has to fix; the status only decides what to add or replace. A 415 is the one
 * refusal whose words are not kept: every such message a driver writes names the kind of device it
 * cannot stream, and which kinds can be streamed is the drivers' knowledge and not this side's, so
 * the console says only that this device cannot be streamed and names no kind.
 */
export function refusalOf(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  // why: an unknown route and an unknown device are the same answer, because a daemon with
  // `capabilities.stream.enabled` off does not mount the route at all and answers like any path it has not heard of.
  if (error.status === 404) {
    return `${error.message} A stream is only offered where capabilities.stream.enabled is on.`;
  }
  if (error.status === 415) {
    return "This device cannot be streamed.";
  }
  return error.message;
}

interface CaptureSinks {
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly conflict: (message: string) => void;
  readonly live: () => void;
  readonly ended: (reason: string) => void;
  readonly setMeta: (meta: StreamMeta) => void;
  readonly setStats: (stats: StreamStats) => void;
}

// why: a stream that ended because this pane asked it to says nothing — the operator pressed Stop,
// and telling them the stream they stopped has stopped is noise.
async function capture(
  api: ReturnType<typeof useApi>,
  workerId: string,
  deviceId: string,
  signal: AbortSignal,
  sinks: CaptureSinks,
): Promise<void> {
  try {
    const { body } = await api.stream(
      `/v1/stream/workers/${encodeURIComponent(workerId)}/devices/${encodeURIComponent(deviceId)}`,
      signal,
      STREAM_HEAD_TIMEOUT_MS,
    );
    sinks.live();
    await readStream(
      body,
      {
        onEnd: (reason) => {
          if (!signal.aborted) sinks.ended(reason ?? "The stream ended.");
        },
        onFrame: (frame) => {
          paint(sinks.canvas.current, frame.displayWidth, frame.displayHeight, frame);
          frame.close();
        },
        onImage: (image) => paint(sinks.canvas.current, image.width, image.height, image),
        onMeta: sinks.setMeta,
        onStats: sinks.setStats,
      },
      signal,
    );
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof ApiError && error.status === 409) sinks.conflict(error.message);
    else sinks.ended(refusalOf(error));
  }
}

function paint(
  target: HTMLCanvasElement | null,
  width: number,
  height: number,
  source: CanvasImageSource,
): void {
  // why: the canvas goes away with the stream, and a frame the decoder was still holding arrives after
  // that; drawing into nothing is what a stream ending looks like from here.
  if (target === null) return;
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  target.getContext("2d")?.drawImage(source, 0, 0);
}
