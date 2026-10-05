---
name: verify-hardware
description: Check a PR's real-device Done when lines on this Mac by running the slow e2e lane through scripts/slow-e2e.sh — one lane per machine, detached, logged — and hand back pass, fail, busy or unavailable. Use when the deliver orchestrator delegates hardware verification, or when the user says "verify #N on hardware".
context: fork
agent: hardware-verifier
---

Run on: $ARGUMENTS

Your instructions are your agent definition, `.claude/agents/hardware-verifier.md`. End with its report block.
