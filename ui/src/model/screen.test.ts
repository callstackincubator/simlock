import { describe, expect, it } from "vitest";

import { readout, type ScreenPhase, screenView } from "./screen";

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

describe("the screen pane", () => {
  const quiet = { ...NONE, error: undefined };

  it("holds a canvas while a picture is asked for or shown, and none when off or stopped", () => {
    const live = (phase: ScreenPhase) =>
      screenView({ meta: undefined, note: undefined, phase, stats: quiet }).live;

    expect([live("idle"), live("starting"), live("live"), live("stopped")]).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("says what it waits for until the first frame is painted, and nothing after", () => {
    const waiting = (phase: ScreenPhase, painted: number) =>
      screenView({ meta: META, note: undefined, phase, stats: { ...quiet, painted } }).waiting;

    expect(waiting("starting", 0)).toBe("Starting the capture on the worker.");
    expect(waiting("live", 0)).toBe("Waiting for the first frame.");
    expect(waiting("live", 1)).toBeUndefined();
    expect(waiting("stopped", 0)).toBeUndefined();
  });

  it("takes the picture's size from the stream, and zero before it is known", () => {
    const sized = screenView({ meta: META, note: undefined, phase: "live", stats: quiet });
    const unsized = screenView({ meta: undefined, note: undefined, phase: "live", stats: quiet });

    expect([sized.width, sized.height, unsized.width, unsized.height]).toEqual([120, 240, 0, 0]);
  });

  it("reads failed on a stream error, or on a stop that left a reason, and not on a plain stop", () => {
    const word = (phase: ScreenPhase, note: string | undefined, error: string | undefined) =>
      screenView({ meta: undefined, note, phase, stats: { ...NONE, error } }).readout.state.word;

    expect(word("live", undefined, "decode failed")).toBe("failed");
    expect(word("stopped", "the worker ended the capture", undefined)).toBe("failed");
    expect(word("stopped", undefined, undefined)).toBe("off");
    expect(word("live", "an old reason", undefined)).toBe("live");
  });
});
