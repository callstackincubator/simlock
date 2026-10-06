---
name: check-spec
description: Check a feature or task spec as posted on GitHub, with a fresh context, before its approval box is ticked or its ready label is set — one spec-checker per task plus one for the feature — and report, with a status for every category, contradictions, lines nobody could check, behaviour no test pins, failure modes no line answers, existing code on the same state no line names, lists the code contradicts, overlapping tasks without a Depends on, slow-lane lines with no test, and undefined terms. Read-only. Use when spec-session reaches the end of technical or split mode, or when the user says "check the spec of #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Spec check #N] <issue title>`, read with `gh issue view`. Skip this step when the arguments name no issue, or the tool is missing or declined: the title never stops the run.
2. **Run.** List the issue's open sub-issues (`gh api graphql`, `subIssues`). Start `spec-checker` agents with the Agent tool, all in one message, no model: none, one with `#<N> task`; else one per open sub-issue with `#<sub-issue> task`, and one with `#<N> feature`. Do not do their work yourself.
3. **Report.** When they finish, print each report block exactly as returned, with nothing added.
