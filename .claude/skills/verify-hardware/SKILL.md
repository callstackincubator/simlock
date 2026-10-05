---
name: verify-hardware
description: Check a PR's real-device Done when lines on this Mac by running the slow e2e lane through scripts/slow-e2e.sh — one lane per machine, detached, logged — and hand back pass, fail, busy or unavailable. Use when the deliver orchestrator delegates hardware verification, or when the user says "verify #N on hardware".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first). If the tool is missing or the rename is declined, carry on without it: the title is a courtesy, never a reason to stop or ask. Title: `[Hardware PR #M] <PR title>`, its title read with `gh issue view` or `gh pr view`. If the arguments name no issue or PR, skip this step.
2. **Run.** Start the `hardware-verifier` agent with the Agent tool: `subagent_type: "hardware-verifier"`, the arguments above as its whole prompt, no model. It starts without this conversation and runs on the model its frontmatter in `.claude/agents/hardware-verifier.md` pins. Do not do its work yourself.
3. **Report.** Wait for it to finish, then print its report block exactly as it returned it, with nothing added.
