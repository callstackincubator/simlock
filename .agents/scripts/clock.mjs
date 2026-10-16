#!/usr/bin/env node
// PostToolUse hook (main session only): appends the local time to the tool result, and how long
// the computer slept since the session's previous tool call, so the orchestrator's status lines
// carry real times and a run that paused while the computer slept says so.
//
//   Local time 07:07. The computer slept 15 min since the last tool call, 88 min this session.
//
// Sleep is wall-clock time minus awake time between two calls: Python's time.monotonic() stops
// while the computer sleeps (mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux), Date.now()
// does not. A gap under a minute is noise and counts as none. State lives in
// $TMPDIR/claude-clock-<session>.json. Sub-agents get nothing: they print no status lines.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOISE_MS = 60_000;

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (typeof input.agent_id === "string" || !input.session_id) process.exit(0);

const now = Date.now();
const awake = awakeMs();
const stateFile = path.join(os.tmpdir(), `claude-clock-${input.session_id}.json`);
let state = { wall: null, awake: null, asleepMs: 0 };
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}

let slept = 0;
// why: the awake clock restarts at a reboot; a smaller reading than the last says nothing.
if (
  awake !== null &&
  typeof state.wall === "number" &&
  typeof state.awake === "number" &&
  awake >= state.awake
) {
  const gap = now - state.wall - (awake - state.awake);
  if (gap >= NOISE_MS) slept = gap;
}
const asleepMs = (state.asleepMs ?? 0) + slept;
fs.writeFileSync(stateFile, JSON.stringify({ wall: now, awake, asleepMs }));

const time = new Date(now).toTimeString().slice(0, 5);
let context = `Local time ${time}.`;
if (slept > 0) {
  context +=
    ` The computer slept ${minutes(slept)} min since the last tool call, ` +
    `${minutes(asleepMs)} min this session.`;
}
console.log(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
  }),
);

function awakeMs() {
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

function minutes(ms) {
  return Math.round(ms / 60_000);
}
