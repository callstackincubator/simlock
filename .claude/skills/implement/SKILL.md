---
name: implement
description: Implement one claimed issue (task, bug, or single-PR feature) tests-first — commit the spec's tests red, open a draft PR, turn them green in checkpoint commits, run pnpm check and pnpm mutate, closing small spec gaps as Assumption lines in the PR body — or apply a list of review or hardware findings to its branch. Ends with a fixed report block. Use when the deliver orchestrator delegates implementation, or when the user says "implement #N".
context: fork
agent: implementer
---

Run on: $ARGUMENTS

Your instructions are your agent definition, `.claude/agents/implementer.md`. End with its report block.
