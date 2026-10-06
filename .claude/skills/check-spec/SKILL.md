---
name: check-spec
description: Check a feature or task spec as posted on GitHub, with a fresh context, before its approval box is ticked or its ready label is set — read the body, its parent or its tasks, the ADRs it names, the agent rules and the code it points at — and report contradictions, lines nobody could check, failure modes no line answers, overlapping tasks without a Depends on, real-device lines with no slow-lane test, and terms a rule depends on that nobody defined, in a fixed block. Read-only. Use when spec-session reaches the end of technical or split mode, or when the user says "check the spec of #N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Spec check #N] <issue title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `spec-checker` agent with the Agent tool: `subagent_type: "spec-checker"`, the arguments above as its whole prompt, no model. Do not do its work yourself.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
