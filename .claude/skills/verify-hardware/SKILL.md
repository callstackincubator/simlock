---
name: verify-hardware
description: Check a PR's slow-lane Done when lines (real devices) on this machine by running the project's slow-lane script — one lane per machine, detached, logged — and hand back pass, fail, busy or unavailable. Use when the deliver orchestrator delegates hardware verification, or when the user says "verify #N on hardware".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Hardware PR #M] <PR title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `hardware-verifier` agent with the Agent tool: `subagent_type: "hardware-verifier"`, the arguments above as its whole prompt, no model. Do not do its work yourself.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
