---
name: verify-hardware
description: Run a PR's slow-lane Done when lines on real devices on this machine and report pass, fail, busy or unavailable. Use when the user says "verify #N on hardware".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Hardware PR #M] <PR title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `hardware-verifier` agent with the Agent tool: `subagent_type: "hardware-verifier"`, no model, its prompt the ledger tag line (`toolchain.md`, "Review measurement") and then the arguments above. Do not do its work yourself.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
