---
name: implement
description: Implement one claimed task or bug one test at a time (build, audit), or apply review or hardware findings to its branch, through the implementer agent. Use when the user says "implement #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Implement #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `implementer` agent with the Agent tool: `subagent_type: "implementer"`, no model, its prompt the ledger tag line (`toolchain.md`, "Review measurement"), then the arguments above as `key: value` lines (a hook adds the mode's brief), one fresh agent per mode, each waited for before the next: `build`, again with the last `remaining` while a report lists `remaining` and built a cycle since the last; then `audit` with the PR's base, merge-base and head from `review-inputs.sh`; `refactor` alone for a refactor issue; `fix` for findings. Stop at `spec needs` under `open`. Do not do its work yourself.
3. **Report.** Print the last report block exactly as returned, with nothing added.
