---
name: check-spec
description: Check a posted feature or task spec with fresh spec-checker agents (one per task, one for the feature) before its ready label is set. Read-only. Use when the user says "check the spec of #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Spec check #N] <issue title>`, read with `gh issue view`. Skip this step when the arguments name no issue, or the tool is missing or declined: the title never stops the run.
2. **Run.** List the issue's open sub-issues (`gh api graphql`, `subIssues`). Start `spec-checker` agents with the Agent tool, all in one message, no model: none, one with `#<N> task`; else one per open sub-issue with `#<sub-issue> task`, and one with `#<N> feature`. Do not do their work yourself.
3. **Report.** When they finish, print each report block exactly as returned, with nothing added.
