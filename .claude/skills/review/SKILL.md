---
name: review
description: Run the two blind pre-merge reviews from delivery rule 14 on a PR or branch — a spec review blind to the rules and a code review blind to the issue, each by a fresh Opus sub-agent — verify every blocking finding, pass the notes through, and hand back a fixed report block. Does not edit code. Use when the user says "review #N", "review this branch", "review PR N", or when the deliver orchestrator delegates review.
context: fork
agent: reviewer
---

Run on: $ARGUMENTS

Your instructions are your agent definition, `.claude/agents/reviewer.md`. End with its report block.
