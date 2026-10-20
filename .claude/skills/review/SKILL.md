---
name: review
description: Run the blind pre-merge spec, code and claims reviews on a PR or branch through the reviewer agent, and hand back its report. Does not edit code. Use when the user says "review #N", "review this branch" or "review PR N".
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Review PR #M] <PR title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `reviewer` agent with the Agent tool: `subagent_type: "reviewer"`, no model, its prompt the ledger tag line (`toolchain.md`, "Review measurement") and then the arguments above. If the user explicitly prohibits sub-agents, perform the
   protocol directly and label it author self-check, not independent review.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
