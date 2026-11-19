import { describe, expect, it } from "vitest";

import type { ProcessEntry } from "../ports/index.js";
import { IdleWatch, type IdleState } from "./idle-watch.js";

const SECOND = 1_000;
const proc = (pid: number, ppid: number, cpuSeconds: number): ProcessEntry => ({
  command: `p${String(pid)}`,
  cpuSeconds,
  pid,
  ppid,
});

function watch() {
  return new IdleWatch({
    idleCores: 0.5,
    readyAt: 0,
    root: (processes) => processes.find((entry) => entry.pid === 100),
  });
}

/** why: a root with one child, each burning `rate` cores, observed every 30 s up to `untilMs`; `at` of `checks` is read right after that observation. */
function run(
  w: IdleWatch,
  rate: (atMs: number) => number,
  untilMs: number,
  checks: Record<number, IdleState> = {},
): void {
  let cpu = 0;
  for (let at = 0; at <= untilMs; at += 30 * SECOND) {
    cpu += rate(at) * 30;
    w.observe([proc(100, 1, cpu / 2), proc(101, 100, cpu / 2), proc(7, 1, 9_999)], at);
    const expected = checks[at / SECOND];
    if (expected !== undefined) expect(w.state(at), `at ${String(at / SECOND)} s`).toBe(expected);
  }
}

// why: pure logic with many cases (testing 6): the driver that owns the watch comes in a later task, so the class is the surface.
describe("IdleWatch", () => {
  it("is idle at 181 s after ready when the tree burned under the idle cores for the last two minutes", () => {
    const w = watch();
    run(w, () => 0.1, 180 * SECOND, { 150: "busy" });
    w.observe([proc(100, 1, 9), proc(101, 100, 9)], 181 * SECOND);

    expect(w.state(181 * SECOND)).toBe("idle");
  });

  it("is busy through a wave at 3 minutes and idle two minutes after it", () => {
    const w = watch();
    run(w, (at) => (at >= 150 * SECOND && at <= 210 * SECOND ? 4 : 0.05), 480 * SECOND, {
      240: "busy",
      300: "busy",
      360: "idle",
      480: "idle",
    });
  });

  it("counts the CPU of a process that exited, so its work leaves the window only with time", () => {
    const w = watch();
    w.observe([proc(100, 1, 0), proc(101, 100, 0)], 0);
    w.observe([proc(100, 1, 1), proc(101, 100, 500)], 150 * SECOND);
    w.observe([proc(100, 1, 2)], 180 * SECOND);
    w.observe([proc(100, 1, 3)], 200 * SECOND);

    expect(w.state(200 * SECOND)).toBe("busy");
    w.observe([proc(100, 1, 4)], 300 * SECOND);
    expect(w.state(300 * SECOND)).toBe("idle");
  });

  it("is busy while the root is not in the table, and idle again once it is back and quiet", () => {
    const w = watch();
    run(w, () => 0.01, 200 * SECOND);
    w.observe([proc(7, 1, 1)], 230 * SECOND);

    expect(w.state(230 * SECOND)).toBe("busy");
  });

  it("is busy with no reading in the last two minutes, a timed-out read leaving none", () => {
    const w = watch();
    run(w, () => 0.01, 200 * SECOND);

    expect(w.state(200 * SECOND)).toBe("idle");
    expect(w.state(330 * SECOND)).toBe("busy");
  });

  it("is at its cap 15 minutes after ready however busy the tree is, or whether the root was ever found", () => {
    const busy = watch();
    run(busy, () => 4, 900 * SECOND);
    const missing = watch();

    expect(busy.state(899 * SECOND)).toBe("busy");
    expect(busy.state(900 * SECOND)).toBe("cap");
    expect(missing.state(900 * SECOND)).toBe("cap");
  });
});
