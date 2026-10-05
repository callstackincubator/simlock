---
name: triage-bug
description: Triage a bug:triage issue — reproduce it as a failing test, find the root cause, and post a report proposing the simplest fix, without fixing it. Use when the user says "triage #N", "triage the next bug", or points at an issue labelled bug:triage.
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first). If the tool is missing or the rename is declined, carry on without it: the title is a courtesy, never a reason to stop or ask. Title: `[Triage #N] <issue title>`, its title read with `gh issue view` or `gh pr view`. If the arguments name no issue or PR, skip this step.
2. **Run.** Start the `bug-triager` agent with the Agent tool: `subagent_type: "bug-triager"`, the arguments above as its whole prompt, no model. It starts without this conversation and runs on the model its frontmatter in `.claude/agents/bug-triager.md` pins. Do not do its work yourself.
3. **Report.** Wait for it to finish, then print its report block exactly as it returned it, with nothing added.
