---
name: triage-bug
description: Triage a bug:triage issue — reproduce it as a failing test, find the root cause, and post a report proposing the simplest fix, without fixing it. Use when the user says "triage #N", "triage the next bug", or points at an issue labelled bug:triage.
context: fork
agent: bug-triager
---

Run on: $ARGUMENTS

Your instructions are your agent definition, `.claude/agents/bug-triager.md`. End with its report block.
