---
name: implement
description: Implement one claimed issue (task or bug) tests-first — commit the spec's tests red, open a draft PR, turn them green in checkpoint commits, run only the tests the change reaches while the git hooks and CI run every other check, closing small spec gaps as Assumption lines in the PR body — or apply a list of review or hardware findings to its branch. Ends with a fixed report block. Use when the deliver orchestrator delegates implementation, or when the user says "implement #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Implement #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `implementer` agent with the Agent tool: `subagent_type: "implementer"`, no model, the arguments above as `key: value` lines. Findings to apply: `mode: fix`, one fresh agent; failing slow-lane tests: `mode: hardware-fix`. Otherwise one fresh agent per mode, each waited for before the next: `mode: red`; `mode: green` with the last report's `map`, again while a report still lists `failing` and turned a test green; then `mode: audit`. Stop at `spec needs` under `open`. Do not do its work yourself.
3. **Report.** Print the last report block exactly as returned, with nothing added.
