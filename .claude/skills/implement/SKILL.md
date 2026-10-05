---
name: implement
description: Implement one claimed issue (task, bug, or single-PR feature) tests-first — commit the spec's tests red, open a draft PR, turn them green in checkpoint commits, run pnpm check and pnpm mutate, closing small spec gaps as Assumption lines in the PR body — or apply a list of review or hardware findings to its branch. Ends with a fixed report block. Use when the deliver orchestrator delegates implementation, or when the user says "implement #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first). If the tool is missing or the rename is declined, carry on without it: the title is a courtesy, never a reason to stop or ask. Title: `[Implement #N] <issue title>`, its title read with `gh issue view` or `gh pr view`. If the arguments name no issue or PR, skip this step.
2. **Run.** Start the `implementer` agent with the Agent tool: `subagent_type: "implementer"`, the arguments above as its whole prompt, no model. It starts without this conversation and runs on the model its frontmatter in `.claude/agents/implementer.md` pins. Do not do its work yourself.
3. **Report.** Wait for it to finish, then print its report block exactly as it returned it, with nothing added.
