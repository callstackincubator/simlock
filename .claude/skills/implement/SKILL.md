---
name: implement
description: Implement one claimed issue (task, bug, or single-PR feature) tests-first — commit the spec's tests red, open a draft PR, turn them green in checkpoint commits, run only the tests the change reaches while the git hooks and CI run every other check, closing small spec gaps as Assumption lines in the PR body — or apply a list of review or hardware findings to its branch. Ends with a fixed report block. Use when the deliver orchestrator delegates implementation, or when the user says "implement #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Implement #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `implementer` agent with the Agent tool: `subagent_type: "implementer"`, the arguments above as its whole prompt, no model. Do not do its work yourself.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
