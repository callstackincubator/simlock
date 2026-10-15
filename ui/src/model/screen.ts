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

// why: a figure counts painted frames, so until the first one is painted every figure is missing
// rather than a misleading zero.
export function readout(input: {
  readonly phase: ScreenPhase;
  readonly failed: boolean;
  readonly meta:
    | { readonly width: number; readonly height: number; readonly codec: string }
    | undefined;
  readonly stats: {
    readonly painted: number;
    readonly framesPerSecond: number;
    readonly kilobitsPerSecond: number;
    readonly dropped: number;
  };
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
