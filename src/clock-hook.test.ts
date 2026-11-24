import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "clock.mjs",
);
const MINUTE = 60_000;

// why: Python's monotonic clock read here, not through awake.mjs, so a wrong clock in the hook
// fails a test instead of agreeing with itself; Windows 11 may answer `python3` with the Store alias.
function awakeNowMs(): number {
  const candidates =
    process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"]];
  for (const [command, ...prefix] of candidates) {
    try {
      const out = execFileSync(
        command!,
        [...prefix, "-c", "import time; print(time.monotonic())"],
        { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
      );
      if (/^\d+(\.\d+)?$/.test(out.trim())) return Number(out) * 1000;
    } catch {}
  }
  throw new Error("no Python 3 on this host");
}

function call(dir: string, input: object): string {
  return spawnSync("node", [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
  }).stdout;
}

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

describe("clock.mjs", () => {
  it("gives the main session the local time after a tool call", () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));
    const before = new Date().toTimeString().slice(0, 5);
    const said = context(call(dir, { session_id: "s1", tool_name: "Agent" }));
    const after = new Date().toTimeString().slice(0, 5);

    expect([`Local time ${before}.`, `Local time ${after}.`]).toContain(said);
  });

  it("says how long the computer slept since the last tool call, and the session's total", () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));
    writeFileSync(
      join(dir, "claude-clock-s1.json"),
      JSON.stringify({
        wall: Date.now() - 20 * MINUTE,
        awake: awakeNowMs() - 5 * MINUTE,
        asleepMs: 30 * MINUTE,
      }),
    );

    const said = context(call(dir, { session_id: "s1", tool_name: "Bash" }));

    expect(said).toContain(
      "The computer slept 15 min since the last tool call, 45 min this session.",
    );
    expect(
      JSON.parse(readFileSync(join(dir, "claude-clock-s1.json"), "utf8")).asleepMs,
    ).toBeGreaterThan(44 * MINUTE);
  });

  it("counts a gap of awake time as no sleep", () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));
    writeFileSync(
      join(dir, "claude-clock-s1.json"),
      JSON.stringify({
        wall: Date.now() - 20 * MINUTE,
        awake: awakeNowMs() - 20 * MINUTE,
        asleepMs: 0,
      }),
    );

    expect(context(call(dir, { session_id: "s1", tool_name: "Bash" }))).not.toContain("slept");
  });

  it("reports no sleep when the awake clock reads less than last time, as after a reboot", () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));
    writeFileSync(
      join(dir, "claude-clock-s1.json"),
      JSON.stringify({
        wall: Date.now() - 20 * MINUTE,
        awake: awakeNowMs() + 60 * MINUTE,
        asleepMs: 0,
      }),
    );

    expect(context(call(dir, { session_id: "s1", tool_name: "Bash" }))).not.toContain("slept");
  });

  it("adds nothing inside a sub-agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));

    expect(call(dir, { session_id: "s1", agent_id: "a1", tool_name: "Bash" })).toBe("");
  });
});
