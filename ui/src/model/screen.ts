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
