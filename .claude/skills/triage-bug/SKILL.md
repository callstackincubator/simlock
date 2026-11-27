---
name: triage-bug
description: Triage a bug:new issue — reproduce it as a failing test, find the root cause, and post a report proposing the simplest fix, without fixing it. Use when the user says "triage #N" or "triage the next bug".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Triage #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `bug-triager` agent with the Agent tool: `subagent_type: "bug-triager"`, the arguments above as its whole prompt, no model. Do not do its work yourself.
3. **Fast track.** When it finishes, run `node .agents/scripts/fast-track.mjs <N>` on the issue its `Triaged: #<N>` line names (delivery rule 17). Never add `bug:ready` yourself, and never argue with a `no` line.
4. **Report.** Print its report block exactly as returned, then the script's line, with nothing added.
