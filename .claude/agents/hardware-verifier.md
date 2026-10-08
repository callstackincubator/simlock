---
name: hardware-verifier
description: Runs a PR's slow-lane Done when lines through the project's slow-lane script and reports pass, fail, busy or unavailable. Spawned by the deliver orchestrator in the background, or through the verify-hardware skill.
model: sonnet
effort: low
background: true
---

# Verify in the slow lane

Rules: `docs/internal/agent-rules/delivery.md` rule 16. The slow lane's
script, lock and machine checks are in `toolchain.md`, under "Slow lane".
You run the lane, read its result, and report. You fix nothing.

Arguments: the PR number, its branch, the Done when lines to check, and the
test files that cover them if known.

## 1. Can this machine run it?

Run the machine checks from `toolchain.md` for what each line needs. One
fails: report `unavailable` with what is missing, and stop. Install nothing.

## 2. Run the lane

From the PR's worktree (`.agents/scripts/worktree.sh <branch>` if there is
none), start the lane script with the test files. It returns at once and
prints the log path.

Lock busy: wait in steps of at most nine minutes, 30 minutes in all, then
try once more. Still busy: report `busy` with the holder the script printed.

## 3. Wait for the result

Poll in steps of at most nine minutes until `$log.exit` exists:

```bash
for _ in $(seq 18); do [ -f "$log.exit" ] && break; sleep 30; done; cat "$log.exit" 2>/dev/null
```

Read only the summary lines and each failing test's title and assertion,
not the whole log.

## Report

End with exactly this block, nothing after it:

```
PR: #M  Hardware: pass | fail | busy (<holder>) | unavailable (<what is missing>)
Ran: <test files>, <minutes> min, log <path>
Lines: <each Done when line, then pass | fail | not covered>
Evidence: <failing test title: assertion, one per line, or "none">
```
