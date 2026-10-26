---
name: implement
description: Implement one claimed task or bug one test at a time (build, audit), or apply review or hardware findings to its branch, through the implementer agent. Use when the user says "implement #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Implement #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `implementer` agent with the Agent tool: `subagent_type: "implementer"`, no model, its prompt the ledger tag line (`toolchain.md`, "Review measurement"), then the arguments above as `key: value` lines, then `brief:` and the full text of `.agents/briefs/implement-<mode>.md` from this checkout, one fresh agent per mode in the **Order** `implementer.md` gives, each waited for before the next. Do not do its work yourself.
3. **Report.** Print the last report block exactly as returned, with nothing added.
