---
name: check-spec
description: Check a feature or task spec as posted on GitHub, with a fresh context, before its approval box is ticked or its ready label is set — read the body, its parent or its tasks, the ADRs it names, the agent rules and the code it points at — and report contradictions, lines nobody could check, failure modes no line answers, overlapping tasks without a Depends on, real-device lines with no slow-lane test, and terms a rule depends on that nobody defined, in a fixed block. Read-only. Use when spec-session reaches the end of technical or split mode, or when the user says "check the spec of #N".
context: fork
agent: spec-checker
---

Run on: $ARGUMENTS

Your instructions are your agent definition, `.claude/agents/spec-checker.md`. End with its report block.
