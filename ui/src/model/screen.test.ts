import { describe, expect, it } from "vitest";

import { readout, type ScreenPhase } from "./screen";

const NONE = { dropped: 0, framesPerSecond: 0, kilobitsPerSecond: 0, painted: 0 };
const META = { codec: "mjpeg", height: 240, width: 120 };

function state(phase: ScreenPhase, failed: boolean) {
  return readout({ failed, meta: undefined, phase, stats: NONE }).state;
}

describe("the screen readout", () => {
  it("shows every figure it cannot yet fill as missing", () => {
    expect(readout({ failed: false, meta: undefined, phase: "idle", stats: NONE }).facts).toEqual([
      { label: "Picture", value: "—" },
      { label: "Frames", value: "—" },
      { label: "Rate", value: "—" },
      { label: "Bandwidth", value: "—" },
      { label: "Dropped", value: "—" },
    ]);
  });

  it("shows the picture's size once known, and the figures once a frame is painted", () => {
    const stats = { dropped: 2, framesPerSecond: 4.96, kilobitsPerSecond: 812.4, painted: 31 };

    expect(readout({ failed: false, meta: META, phase: "live", stats: NONE }).facts[0]?.value).toBe(
      "120 × 240 mjpeg",
    );
    expect(
      readout({ failed: false, meta: META, phase: "live", stats }).facts.map((fact) => fact.value),
    ).toEqual(["120 × 240 mjpeg", "31", "5.0 fps", "812 kbit/s", "2"]);
  });

  it("names the state as a word with its tone, and a failure outranks the phase", () => {
    expect(state("idle", false)).toEqual({ tone: "idle", word: "off" });
    expect(state("stopped", false)).toEqual({ tone: "idle", word: "off" });
    expect(state("starting", false)).toEqual({ tone: "idle", word: "starting" });
    expect(state("live", false)).toEqual({ tone: "ok", word: "live" });
    expect(state("live", true)).toEqual({ tone: "error", word: "failed" });
  });
});
