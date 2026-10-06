import { spawn } from "node:child_process";
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
  "budget-guard.mjs",
);
const HOUR = 3_600_000;

/**
 * Runs the hook once for a session with an empty transcript and a one-hour time limit, from a
 * saved state of `activeMs` active time and a last tool call `sinceLastCallMs` ago. The hook
 * runs under its own `sh`, in its own process group: at its hard limit it kills its parent's
 * group, which must never be the test runner.
 */
async function call(activeMs: number, sinceLastCallMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "budget-guard-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  const stateFile = join(dir, "claude-budget-s1.json");
  writeFileSync(
    stateFile,
    JSON.stringify({ activeMs, lastSeen: Date.now() - sinceLastCallMs, files: {} }),
  );
  // The trailing `exit` keeps sh from exec-ing node, so sh stays the hook's parent.
  const child = spawn("sh", ["-c", '"$0" "$1"; exit $?', process.execPath, SCRIPT], {
    detached: true,
    env: { ...process.env, TMPDIR: dir, CLAUDE_BUDGET_TOKENS: "0", CLAUDE_BUDGET_HOURS: "1" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(
    JSON.stringify({ transcript_path: transcript, session_id: "s1", tool_name: "Read" }),
  );
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { activeMs: number };
  return { status, stderr, activeMs: state.activeMs };
}

describe("budget-guard time limit", () => {
  it("counts a gap of a few seconds between tool calls as run time, and blocks the call once active time passes the limit", async () => {
    const result = await call(HOUR - 1_000, 5_000);
    expect(result.activeMs).toBeGreaterThanOrEqual(HOUR + 4_000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Budget limit reached");
  });

  it("does not count a gap of over 30 minutes between tool calls, so a session idle overnight is not stopped", async () => {
    const result = await call(HOUR - 1_000, 8 * HOUR);
    expect(result.activeMs).toBe(HOUR - 1_000);
    expect(result.status).toBe(0);
  });
});
