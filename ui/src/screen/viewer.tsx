/**
 * why: one button turns a device's picture on and off and nothing else controls it, because this
 * surface has no command of its own to send — the request *is* the on command and aborting it *is* the
 * off one. So the pane's lifecycle is the capture's lifecycle: closing the page, navigating away,
 * signing out and pressing Stop are four ways of doing the same single thing, and a capture cannot
 * outlive the pane that asked for it. That is also why nothing here polls, retries, or holds a stream
 * open across a navigation.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api";
import { useApi } from "../console-context";
import { Panel } from "../layout";
import { Status, type Tone } from "../status";
import { readStream, type StreamMeta, type StreamStats } from "./stream";

type Phase = "idle" | "starting" | "live" | "stopped";

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

function useScreenStream(leaseId: string, canvas: RefObject<HTMLCanvasElement | null>) {
  const api = useApi();
  const controller = useRef<AbortController | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
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
    void (async () => {
      try {
        const { body } = await api.stream(
          `/v1/stream/leases/${encodeURIComponent(leaseId)}`,
          abort.signal,
          STREAM_HEAD_TIMEOUT_MS,
        );
        setPhase("live");
        await readStream(
          body,
          {
            onEnd: (reason) => {
              // why: a stream that ended because this pane asked it to says nothing — the operator
              // pressed Stop, and telling them the stream they stopped has stopped is noise.
              if (abort.signal.aborted) return;
              setNote(reason ?? "The stream ended.");
              setPhase("stopped");
            },
            onFrame: (frame) => {
              paint(canvas.current, frame.displayWidth, frame.displayHeight, frame);
              frame.close();
            },
            onImage: (image) => paint(canvas.current, image.width, image.height, image),
            onMeta: setMeta,
            onStats: setStats,
          },
          abort.signal,
        );
      } catch (error) {
        if (abort.signal.aborted) return;
        setNote(refusalOf(error));
        setPhase("stopped");
      }
    })();
  }, [api, leaseId]);

  return { meta, note, phase, start, stats, stop };
}

export function ScreenPane({ leaseId }: { readonly leaseId: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { meta, note, phase, start, stats, stop } = useScreenStream(leaseId, canvas);
  const live = phase === "live" || phase === "starting";
  const failure = stats.error ?? (phase === "stopped" ? note : undefined);
  // why: the canvas is mounted as soon as a picture has been asked for rather than when the first frame
  // arrives — a frame can arrive before React has painted anything, and a pane that mounts its canvas
  // in reply to that frame has nothing to draw the first picture on. It goes away with the stream
  // rather than staying: a last frame kept on the page after Stop looks like a live device and shows a
  // screen its viewer has already asked not to see.
  const shown = live;
  const waiting = shown && stats.painted === 0;
  return (
    <Panel
      title="Screen"
      description="A live view of the device, captured on the worker that holds it. Nothing runs while this is off."
      actions={
        <button className="button button-secondary" onClick={live ? stop : start} type="button">
          {live ? "Stop" : "Show screen"}
        </button>
      }
    >
      <ScreenPicture canvas={canvas} meta={meta} phase={phase} shown={shown} waiting={waiting} />
      <ScreenFacts failed={failure !== undefined} meta={meta} phase={phase} stats={stats} />
      {note === undefined ? null : (
        <p className="refusal" role="alert">
          {note}
        </p>
      )}
    </Panel>
  );
}

function ScreenPicture({
  canvas,
  meta,
  phase,
  shown,
  waiting,
}: {
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly meta: StreamMeta | undefined;
  readonly phase: Phase;
  readonly shown: boolean;
  readonly waiting: boolean;
}) {
  return (
    <>
      {shown ? (
        <canvas
          aria-label="The leased device's screen"
          className="screen"
          height={meta?.height ?? 0}
          ref={canvas}
          width={meta?.width ?? 0}
        />
      ) : (
        <p className="muted">No picture while this is off.</p>
      )}
      {waiting ? (
        <p className="muted">
          {phase === "starting"
            ? "Starting the capture on the worker."
            : "Waiting for the first frame."}
        </p>
      ) : null}
    </>
  );
}

function ScreenFacts({
  failed,
  meta,
  phase,
  stats,
}: {
  readonly failed: boolean;
  readonly meta: StreamMeta | undefined;
  readonly phase: Phase;
  readonly stats: StreamStats;
}) {
  const tone: Tone = failed ? "error" : phase === "live" ? "ok" : "idle";
  return (
    <dl className="facts">
      <div>
        <dt>State</dt>
        <dd>
          <Status tone={tone}>{stateWord(phase, failed)}</Status>
        </dd>
      </div>
      <div>
        <dt>Picture</dt>
        <dd className="mono">{meta === undefined ? "—" : pictureOf(meta)}</dd>
      </div>
      <div>
        <dt>Frames</dt>
        <dd className="mono">{counted(stats, (frames) => `${frames}`)}</dd>
      </div>
      <div>
        <dt>Rate</dt>
        <dd className="mono">{counted(stats, () => `${stats.framesPerSecond.toFixed(1)} fps`)}</dd>
      </div>
      <div>
        <dt>Bandwidth</dt>
        <dd className="mono">
          {counted(stats, () => `${Math.round(stats.kilobitsPerSecond)} kbit/s`)}
        </dd>
      </div>
      <div>
        <dt>Dropped</dt>
        <dd className="mono">{counted(stats, () => `${stats.dropped}`)}</dd>
      </div>
    </dl>
  );
}

function counted(stats: StreamStats, show: (frames: number) => string): string {
  return stats.painted === 0 ? "—" : show(stats.painted);
}

function pictureOf(meta: StreamMeta): string {
  return `${meta.width} × ${meta.height} ${meta.codec}`;
}

function stateWord(phase: Phase, failed: boolean): string {
  if (failed) return "failed";
  if (phase === "live") return "live";
  if (phase === "starting") return "starting";
  return "off";
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
