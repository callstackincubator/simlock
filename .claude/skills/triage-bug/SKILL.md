---
name: triage-bug
description: Triage a bug:triage issue — reproduce it as a failing test, find the root cause, and post a report proposing the simplest fix, without fixing it. Use when the user says "triage #N", "triage the next bug", or points at an issue labelled bug:triage.
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Triage #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `bug-triager` agent with the Agent tool: `subagent_type: "bug-triager"`, the arguments above as its whole prompt, no model. Do not do its work yourself.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
