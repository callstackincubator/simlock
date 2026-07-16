import { describe, expect, it } from "vitest";

import { FakeClock } from "./index.js";

describe("FakeClock", () => {
  it("fires due timers in deadline order when advanced", () => {
    const clock = new FakeClock(100);
    const fired: string[] = [];

    clock.setTimer(30, () => fired.push("third"));
    clock.setTimer(10, () => fired.push("first"));
    clock.setTimer(20, () => fired.push("second"));

    clock.advance(30);

    expect(fired).toEqual(["first", "second", "third"]);
    expect(clock.now()).toBe(130);
  });

  it("does not fire a cancelled timer", () => {
    const clock = new FakeClock();
    const callback = () => {
      throw new Error("cancelled timer fired");
    };

    const handle = clock.setTimer(10, callback);
    clock.cancel(handle);

    clock.advance(10);
  });

  it("fires a timer scheduled for an already-passed deadline during advance", () => {
    const clock = new FakeClock();
    const fired: string[] = [];

    clock.setTimer(10, () => {
      fired.push("first");
      clock.setTimer(20, () => fired.push("second"));
    });

    clock.advance(100);

    expect(fired).toEqual(["first", "second"]);
    expect(clock.now()).toBe(100);
  });
});
