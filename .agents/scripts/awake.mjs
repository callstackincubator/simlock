// Milliseconds of awake time since boot, from a clock that stops while the computer sleeps
// (time.monotonic(): mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux); null when python3
// is missing. clock.mjs reports sleep with it, and budget-guard.mjs counts active time with it.
import { execFileSync } from "node:child_process";

export function awakeMs() {
  try {
    const out = execFileSync("python3", ["-I", "-c", "import time; print(time.monotonic())"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return Number(out) * 1000;
  } catch {
    return null;
  }
}
