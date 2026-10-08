---
name: review
description: Run the blind pre-merge reviews from delivery rule 14 on a PR or branch — a spec review blind to the rules, two code reviews and a claims review blind to the issue, each by a fresh Opus sub-agent; later rounds review only the fix — verify every blocking finding, pass the notes through, and hand back a fixed report block. Does not edit code. Use when the user says "review #N", "review this branch", "review PR N", or when the deliver orchestrator delegates review.
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first) to `[Review PR #M] <PR title>`, read with `gh issue view` or `gh pr view`. Skip this step when the arguments name no issue or PR, or the tool is missing or declined: the title never stops the run.
2. **Run.** Start the `reviewer` agent with the Agent tool: `subagent_type: "reviewer"`, the arguments above as its whole prompt, no model. Do not do its work yourself.
3. **Report.** When it finishes, print its report block exactly as returned, with nothing added.
