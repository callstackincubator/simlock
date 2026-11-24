// Milliseconds of awake time since boot, from a clock that stops while the computer sleeps
// (time.monotonic(): mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux); null when no Python 3
// is found. clock.mjs reports sleep with it, and budget-guard.mjs counts active time with it.
import { execFileSync } from "node:child_process";

// why: on Windows 11 `python3` is by default the Microsoft Store alias, which prints "Python was
// not found" instead of a version, so there a candidate counts only when `--version` says Python 3.
const WINDOWS_CANDIDATES = [["python3"], ["python"], ["py", "-3"]];

function python() {
  if (process.platform !== "win32") return ["python3"];
  for (const [command, ...prefix] of WINDOWS_CANDIDATES) {
    try {
      const out = execFileSync(command, [...prefix, "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
      if (out.startsWith("Python 3")) return [command, ...prefix];
    } catch {}
  }
  return null;
}

export function awakeMs() {
  try {
    const found = python();
    if (found === null) return null;
    const [command, ...prefix] = found;
    const out = execFileSync(
      command,
      [...prefix, "-I", "-c", "import time; print(time.monotonic())"],
      {
        encoding: "utf8",
        timeout: 2_000,
      },
    );
    return Number(out) * 1000;
  } catch {
    return null;
  }
}
