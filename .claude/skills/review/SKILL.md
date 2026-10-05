---
name: review
description: Run the two blind pre-merge reviews from delivery rule 14 on a PR or branch — a spec review blind to the rules and a code review blind to the issue, each by a fresh Opus sub-agent — verify every blocking finding, pass the notes through, and hand back a fixed report block. Does not edit code. Use when the user says "review #N", "review this branch", "review PR N", or when the deliver orchestrator delegates review.
---

Arguments: $ARGUMENTS

1. **Title.** Rename this session with `mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it with ToolSearch first). If the tool is missing or the rename is declined, carry on without it: the title is a courtesy, never a reason to stop or ask. Title: `[Review PR #M] <PR title>`, its title read with `gh issue view` or `gh pr view`. If the arguments name no issue or PR, skip this step.
2. **Run.** Start the `reviewer` agent with the Agent tool: `subagent_type: "reviewer"`, the arguments above as its whole prompt, no model. It starts without this conversation and runs on the model its frontmatter in `.claude/agents/reviewer.md` pins. Do not do its work yourself.
3. **Report.** Wait for it to finish, then print its report block exactly as it returned it, with nothing added.
