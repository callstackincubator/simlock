---
name: verify-hardware
description: Check a PR's real-device Done when lines on this Mac by running the slow e2e lane through scripts/slow-e2e.sh — one lane per machine, detached, logged — and hand back pass, fail, busy or unavailable. Use when the deliver orchestrator delegates hardware verification, or when the user says "verify #N on hardware".
model: sonnet
effort: low
context: fork
---

# Verify on real hardware

Rule 16 in `docs/internal/agent-rules/delivery.md` governs this skill. You
run the slow lane, read its result, and report. You do not fix anything.

Arguments: the PR number, its branch, the Done when lines to check, and the
test files that cover them if the orchestrator knows them.

## 1. Can this machine run it?

```bash
uname -s                      # Darwin is needed for iOS
xcrun simctl list runtimes    # an iOS line needs at least one runtime
command -v emulator adb       # an Android line needs the SDK on PATH
```

Missing what a line needs: report `unavailable` with what is missing and
stop. Do not install anything (safety rules: no implicit downloads).

## 2. Run the lane

From the PR's worktree (`.agents/scripts/worktree.sh <branch>` if there is
none), start the run. It returns at once and prints the log path:

```bash
log=$(scripts/slow-e2e.sh <test files>)
```

Exit 75 means another worktree's slow run holds the lock. Wait for it in
steps of at most nine minutes, for 30 minutes in all, then try again once;
still busy, report `busy` with the holder the script printed.

## 3. Wait for the result

The run is detached, so no tool time limit can kill it. Poll in steps of at
most nine minutes until `$log.exit` exists:

```bash
for _ in $(seq 18); do [ -f "$log.exit" ] && break; sleep 30; done; cat "$log.exit" 2>/dev/null
```

Then read only what decides the result: the summary lines and each failing
test's title and assertion, not the whole log.

## Report

End with exactly this block, nothing after it:

```
PR: #M  Hardware: pass | fail | busy (<holder>) | unavailable (<what is missing>)
Ran: <test files>, <minutes> min, log <path>
Lines: <each Done when line, then pass | fail | not covered>
Evidence: <failing test title: assertion, one per line, or "none">
```
