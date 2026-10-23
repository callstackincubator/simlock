import { type WorkerView, workerName } from "./workers";
import type { Toned } from "./tones";

export type ScreenPhase = "idle" | "starting" | "live" | "stopped";

export interface ScreenFact {
  readonly label: string;
  readonly value: string;
}

export interface Readout {
  readonly state: Toned;
  readonly facts: readonly ScreenFact[];
}

function stateOf(phase: ScreenPhase, failed: boolean): Toned {
  if (failed) return { tone: "error", word: "failed" };
  if (phase === "live") return { tone: "ok", word: "live" };
  if (phase === "starting") return { tone: "idle", word: "starting" };
  return { tone: "idle", word: "off" };
}

type Meta = { readonly width: number; readonly height: number; readonly codec: string };
type Stats = {
  readonly painted: number;
  readonly framesPerSecond: number;
  readonly kilobitsPerSecond: number;
  readonly dropped: number;
};

export interface ScreenView {
  readonly width: number;
  readonly height: number;
  readonly live: boolean;
  readonly waiting: string | undefined;
  readonly readout: Readout;
  readonly note: string | undefined;
}

// why: a figure counts painted frames, so until the first one is painted every figure is missing
// rather than a misleading zero.
export function readout(input: {
  readonly phase: ScreenPhase;
  readonly failed: boolean;
  readonly meta: Meta | undefined;
  readonly stats: Stats;
}): Readout {
  const { failed, meta, phase, stats } = input;
  const counted = (show: string) => (stats.painted === 0 ? "—" : show);
  return {
    facts: [
      {
        label: "Picture",
        value: meta === undefined ? "—" : `${meta.width} × ${meta.height} ${meta.codec}`,
      },
      { label: "Frames", value: counted(String(stats.painted)) },
      { label: "Rate", value: counted(`${stats.framesPerSecond.toFixed(1)} fps`) },
      { label: "Bandwidth", value: counted(`${Math.round(stats.kilobitsPerSecond)} kbit/s`) },
      { label: "Dropped", value: counted(String(stats.dropped)) },
    ],
    state: stateOf(phase, failed),
  };
}

// why: the canvas is mounted as soon as a picture has been asked for rather than when the first frame
// arrives — a frame can arrive before React has painted anything, and a pane that mounts its canvas
// in reply to that frame has nothing to draw the first picture on. It goes away with the stream
// rather than staying: a last frame kept on the page after Stop looks like a live device and shows a
// screen its viewer has already asked not to see.
export function screenView(input: {
  readonly phase: ScreenPhase;
  readonly meta: Meta | undefined;
  readonly stats: Stats & { readonly error: string | undefined };
  readonly note: string | undefined;
}): ScreenView {
  const { meta, note, phase, stats } = input;
  const live = phase === "live" || phase === "starting";
  const failure = stats.error ?? (phase === "stopped" ? note : undefined);
  const waitingNote =
    phase === "starting" ? "Starting the capture on the worker." : "Waiting for the first frame.";
  return {
    height: meta?.height ?? 0,
    live,
    note,
    readout: readout({ failed: failure !== undefined, meta, phase, stats }),
    waiting: live && stats.painted === 0 ? waitingNote : undefined,
    width: meta?.width ?? 0,
  };
}

export interface StreamOffer {
  readonly offered: boolean;
  readonly reason?: string;
}

// why: a worker answers a stream request with a 404 when its `stream` capability is not on, so the
// console says so before it asks; a worker the console cannot see is left to the daemon's own
// answer.
export function streamOffer(worker: WorkerView | undefined): StreamOffer {
  if (worker === undefined) return { offered: true };
  const entry = worker.capabilities?.find((capability) => capability.name === "stream");
  if (entry?.state === "available") return { offered: true };
  const name = workerName(worker);
  if (entry?.state === "unavailable") {
    const reason = `Streaming is unavailable on ${name}. ${entry.reason ?? ""}`;
    return { offered: false, reason: reason.trim() };
  }
  return { offered: false, reason: `Streaming is off on ${name}.` };
}

// why: the daemon streams a device that is ready or leased, and the console asks for a picture only
// then; a change from one to the other is no reason to ask again.
const STREAMING_STATES: ReadonlySet<string> = new Set(["ready", "leased"]);

const WAITING_SENTENCES: ReadonlyMap<string, string> = new Map([
  ["shutdown", "The device is shut down. Its screen shows while it runs."],
  ["provisioning", "The device is starting. Its screen shows once it is ready."],
  ["reclaiming", "The device is being reset. Its screen shows once it is ready."],
  ["quarantined", "The device is quarantined. It has no screen to show."],
  ["absent", "The device is not connected. Its screen shows once it is back."],
]);

export function streamsDevice(state: string, offer: StreamOffer): boolean {
  return offer.offered && STREAMING_STATES.has(state);
}

export type DeviceScreen =
  | { readonly kind: "picture" }
  | { readonly kind: "sentence"; readonly text: string };

// why: `conflict` is the daemon's 409 message for a device the row still calls ready or leased: the
// row is behind, and the daemon's words stand until it catches up. A state word this console does
// not know is shown as itself, because wire input is a claim.
export function deviceScreen(input: {
  readonly state: string;
  readonly offer: StreamOffer;
  readonly conflict: string | undefined;
}): DeviceScreen {
  const { conflict, offer, state } = input;
  if (!offer.offered) return { kind: "sentence", text: offer.reason ?? "" };
  if (STREAMING_STATES.has(state)) {
    return conflict === undefined ? { kind: "picture" } : { kind: "sentence", text: conflict };
  }
  return {
    kind: "sentence",
    text: WAITING_SENTENCES.get(state) ?? `The device is ${state}. It has no screen to show.`,
  };
}
