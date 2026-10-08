import { describe, expect, it } from "vitest";

import type { DeviceSpec } from "../domain.js";
import { RETRY_FIRST_MS, RETRY_MAX_MS, RetrySchedule } from "./retry.js";

const minute = 60_000;
const spec: DeviceSpec = { model: "iPhone 17", osVersion: "26.0", platform: "ios" };
const other: DeviceSpec = { model: "iPhone 16", osVersion: "18.4", platform: "ios" };

/** Fails `times` in a row, each at the first moment a try is allowed; returns the last failure. */
function failTimes(schedule: RetrySchedule, target: DeviceSpec, times: number): number {
  let at = 0;
  for (let failure = 0; failure < times; failure += 1) {
    schedule.failed(target, at);
    if (failure < times - 1) at = schedule.nextAttemptAt(at) ?? at;
  }
  return at;
}

describe("retry schedule", () => {
  it("allows a spec that never failed", () => {
    expect(new RetrySchedule().mayAttempt(spec, 0)).toBe(true);
  });

  it("after one failure allows a try one minute later and not a moment before", () => {
    const schedule = new RetrySchedule();

    schedule.failed(spec, 1_000);

    expect(RETRY_FIRST_MS).toBe(minute);
    expect(schedule.mayAttempt(spec, 1_000)).toBe(false);
    expect(schedule.mayAttempt(spec, 1_000 + minute - 1)).toBe(false);
    expect(schedule.mayAttempt(spec, 1_000 + minute)).toBe(true);
  });

  it("after three failures in a row allows a try four minutes later", () => {
    const schedule = new RetrySchedule();

    const last = failTimes(schedule, spec, 3);

    expect(schedule.mayAttempt(spec, last + 4 * minute - 1)).toBe(false);
    expect(schedule.mayAttempt(spec, last + 4 * minute)).toBe(true);
  });

  it("never allows a try more than ten minutes after the last failure", () => {
    const schedule = new RetrySchedule();

    const last = failTimes(schedule, spec, 12);

    expect(RETRY_MAX_MS).toBe(10 * minute);
    expect(schedule.mayAttempt(spec, last + 10 * minute - 1)).toBe(false);
    expect(schedule.mayAttempt(spec, last + 10 * minute)).toBe(true);
  });

  it("clears the schedule on a success, so the next failure waits one minute again", () => {
    const schedule = new RetrySchedule();
    const last = failTimes(schedule, spec, 3);

    schedule.succeeded(spec);

    expect(schedule.mayAttempt(spec, last)).toBe(true);
    expect(schedule.nextAttemptAt(last)).toBeUndefined();
    schedule.failed(spec, last);
    expect(schedule.mayAttempt(spec, last + minute - 1)).toBe(false);
    expect(schedule.mayAttempt(spec, last + minute)).toBe(true);
  });

  it("keeps each spec's schedule apart", () => {
    const schedule = new RetrySchedule();

    schedule.failed(spec, 0);

    expect(schedule.mayAttempt(other, 0)).toBe(true);
    schedule.succeeded(other);
    expect(schedule.mayAttempt(spec, 0)).toBe(false);
  });

  it("treats equal specs as one spec and a slim spec as another", () => {
    const schedule = new RetrySchedule();

    schedule.failed({ ...spec }, 0);

    expect(schedule.mayAttempt(spec, 0)).toBe(false);
    expect(schedule.mayAttempt({ ...spec, mode: "slim" }, 0)).toBe(true);
  });

  it("names the earliest moment after now a held-back spec may be tried, and none once it may", () => {
    const schedule = new RetrySchedule();
    schedule.failed(spec, 0);
    schedule.failed(other, 30_000);
    schedule.failed(other, 30_000 + minute);

    expect(schedule.nextAttemptAt(30_000)).toBe(minute);
    expect(schedule.nextAttemptAt(minute)).toBe(30_000 + minute + 2 * minute);
    expect(schedule.nextAttemptAt(30_000 + 3 * minute)).toBeUndefined();
  });

  it("names the earliest moment even when the spec that failed first is not the one held back for the shortest time", () => {
    const schedule = new RetrySchedule();
    schedule.failed(spec, 100_000);
    schedule.failed(other, 0);

    expect(schedule.nextAttemptAt(0)).toBe(minute);
  });
});
