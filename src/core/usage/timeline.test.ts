import { describe, expect, it } from "vitest";

import { peakAndMean, segmentsOf, type Step, valuesAt } from "./timeline.js";

const step = (at: number, key: string, value: number): Step<number> => ({ at, key, value });
const sum = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);

describe("segmentsOf", () => {
  it("starts with the step in force at the start of the window and cuts a segment at each later step", () => {
    const segments = segmentsOf([step(5, "a", 1), step(20, "a", 3), step(40, "a", 0)], 10, 50);

    expect(segments).toEqual([
      { end: 20, start: 10, values: [1] },
      { end: 40, start: 20, values: [3] },
      { end: 50, start: 40, values: [0] },
    ]);
  });

  it("holds no value before the first step, and reads a step at the very start of the window as in force", () => {
    const segments = segmentsOf([step(30, "a", 2)], 10, 50);
    const atStart = segmentsOf([step(10, "a", 2)], 10, 50);

    expect(segments).toEqual([
      { end: 30, start: 10, values: [] },
      { end: 50, start: 30, values: [2] },
    ]);
    expect(atStart).toEqual([{ end: 50, start: 10, values: [2] }]);
  });

  it("leaves out steps after the end of the window, and keeps one value for each key", () => {
    const segments = segmentsOf(
      [step(5, "a", 1), step(6, "b", 10), step(30, "a", 2), step(80, "b", 99)],
      10,
      50,
    );

    expect(segments).toEqual([
      { end: 30, start: 10, values: [1, 10] },
      { end: 50, start: 30, values: [2, 10] },
    ]);
  });
});

describe("valuesAt", () => {
  it("answers the values in force at each time, counting a step at that time", () => {
    const steps = [step(5, "a", 1), step(20, "a", 3), step(20, "b", 7)];

    expect(valuesAt(steps, [4, 5, 19, 20, 99])).toEqual([[], [1], [1], [3, 7], [3, 7]]);
  });
});

describe("peakAndMean", () => {
  it("weighs each segment by its time and leaves out the time before the first step", () => {
    const segments = segmentsOf([step(30, "a", 4), step(40, "a", 0)], 0, 60);

    expect(peakAndMean(segments, sum)).toEqual({ mean: 40 / 30, peak: 4 });
    expect(peakAndMean(segmentsOf<number>([], 0, 60), sum)).toBeUndefined();
  });

  it("gives no weight to a segment with no time in it", () => {
    const segments = segmentsOf([step(10, "a", 100), step(10, "a", 2)], 0, 20);

    expect(peakAndMean(segments, sum)).toEqual({ mean: 2, peak: 2 });
  });
});
