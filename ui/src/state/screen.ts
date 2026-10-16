/**
 * why: one button turns a device's picture on and off and nothing else controls it, because this
 * surface has no command of its own to send — the request *is* the on command and aborting it *is* the
 * off one. So the pane's lifecycle is the capture's lifecycle: closing the page, navigating away,
 * signing out and pressing Stop are four ways of doing the same single thing, and a capture cannot
 * outlive the pane that asked for it. That is also why nothing here polls, retries, or holds a stream
 * open across a navigation.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../data/api";
import { readStream, type StreamMeta, type StreamStats } from "../data/stream";
import { type Readout, type ScreenPhase, screenView } from "../model/screen";
import { useApi } from "./services";

export type { Readout } from "../model/screen";

const EMPTY: StreamStats = {
  dropped: 0,
  error: undefined,
  fed: 0,
  framesPerSecond: 0,
  kilobitsPerSecond: 0,
  painted: 0,
};

// why: a worker answers a stream's headers only once its capture wrote its first frame, and it may
// take up to 75 s to give up (an emulator's push 30 s, its server 15 s, the first frame 30 s); a
// console that gave up at the API's usual 10 s would show its own timeout instead of the worker's
// reason.
const STREAM_HEAD_TIMEOUT_MS = 90_000;

export interface Screen {
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly width: number;
  readonly height: number;
  readonly live: boolean;
  readonly waiting: string | undefined;
  readonly readout: Readout;
  readonly note: string | undefined;
  readonly start: () => void;
  readonly stop: () => void;
}

export function useScreen(leaseId: string): Screen {
  const api = useApi();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const [phase, setPhase] = useState<ScreenPhase>("idle");
  const [meta, setMeta] = useState<StreamMeta | undefined>(undefined);
  const [stats, setStats] = useState<StreamStats>(EMPTY);
  const [note, setNote] = useState<string | undefined>(undefined);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
    setPhase("stopped");
  }, []);

  // why: leaving the page stops the capture with the same abort the Stop button performs — a page that
  // was navigated away from must not leave a device being filmed for a viewer that is no longer there.
  // Navigating to another lease is that same event, and asks for the other lease's picture instead.
  useEffect(() => stop, [leaseId, stop]);

  const start = useCallback(() => {
    const abort = new AbortController();
    controller.current = abort;
    setNote(undefined);
    setMeta(undefined);
    setStats(EMPTY);
    setPhase("starting");
    void capture(api, leaseId, abort.signal, {
      canvas,
      ended: (reason) => {
        setNote(reason);
        setPhase("stopped");
      },
      live: () => setPhase("live"),
      setMeta,
      setStats,
    });
  }, [api, leaseId]);

  return { canvas, start, stop, ...screenView({ meta, note, phase, stats }) };
}

/**
 * why: the daemon names its reason in its own words and those words are kept, because they say what its
 * operator has to fix; the status only decides what to add, since a refusal the console can explain
 * better than the daemon did — a device that cannot be streamed at all — would otherwise leave the
 * reader with a sentence that does not say what to do.
 */
export function refusalOf(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  // why: an unknown route and an unknown lease are the same answer, because a daemon with
  // `capabilities.stream.enabled` off does not mount the route at all and answers like any path it has not heard of.
  if (error.status === 404) {
    return `${error.message} A stream is only offered where capabilities.stream.enabled is on, and only for a lease that is still held.`;
  }
  if (error.status === 415) {
    return "This device cannot be streamed. A live screen is captured from a simulator or an emulator, not from a physical phone.";
  }
  return error.message;
}

interface CaptureSinks {
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly live: () => void;
  readonly ended: (reason: string) => void;
  readonly setMeta: (meta: StreamMeta) => void;
  readonly setStats: (stats: StreamStats) => void;
}

// why: a stream that ended because this pane asked it to says nothing — the operator pressed Stop,
// and telling them the stream they stopped has stopped is noise.
async function capture(
  api: ReturnType<typeof useApi>,
  leaseId: string,
  signal: AbortSignal,
  sinks: CaptureSinks,
): Promise<void> {
  try {
    const { body } = await api.stream(
      `/v1/stream/leases/${encodeURIComponent(leaseId)}`,
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
    if (!signal.aborted) sinks.ended(refusalOf(error));
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
