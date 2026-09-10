---
name: triage-bug
description: Triage a bug:triage issue — reproduce it as a failing test, find the root cause, and post a report proposing the simplest fix, without fixing it. Use when the user says "triage #N", "triage the next bug", or points at an issue labelled bug:triage.
---

# Triage a bug

You produce a report, not a fix. Rule 8 in `docs/agent-rules/delivery.md`
defines the report; `docs/agent-rules/testing.md` defines what a reproduction
is worth.

Argument: an issue number. Without one, take the oldest:

```bash
gh issue list --label bug:triage --search 'no:assignee' --json number,title --jq 'sort_by(.number)[0]'
```

## 1. Claim

Check the issue carries exactly `bug:triage` and has no assignee. If either
is false, stop and say so. Otherwise:

```bash
gh issue edit <N> --add-assignee @me
```

Then look for a previous attempt and continue from it rather than repeating
it:

```bash
gh issue view <N> --json comments --jq '[.comments[] | select(.body | startswith("## Handoff"))] | last | .body'
git fetch origin bug/<N>-repro 2>/dev/null && git log --oneline origin/bug/<N>-repro ^main
```

## 2. Reproduce

Read the body and the comment thread. Write a test whose title is the claim
the bug makes, in the project that can prove it — a unit test when the
behaviour is in-process, an e2e test when it needs a daemon. The test must
fail on a named assertion, not a timeout. Run it and keep the failing output.

Do not run the slow e2e lane or anything that needs real simulators or
emulators without asking the maintainer first. If reproduction needs it, ask;
if the answer is no, say so in the report and go as far as the fake driver
allows.

If you cannot reproduce after a genuine attempt:

```bash
gh issue comment <N> --body "<what you tried, and exactly what information would let you reproduce it>"
gh issue edit <N> --add-label bug:needs-info --remove-label bug:triage --remove-assignee @me
```

and stop.

## 3. Find the root cause

Follow the failing assertion back to the line that makes it fail. Name the
file and line. Distinguish the root cause from the place the symptom shows
up. If the cause is a decision rather than a defect — the code does what an
ADR says and the ADR is wrong — say so; that bug becomes a feature with a
superseding ADR, not a fix.

## 4. Push the reproduction

```bash
git switch -c bug/<N>-repro main
git add <test files only>
git commit -m "test: reproduce #<N> — <claim>"
git push -u origin bug/<N>-repro
```

Only the test goes on this branch. No fix, no pull request.

## 5. Report and release

Post one comment with exactly these sections, then unassign:

```markdown
## Reproduction

<test file and title, the command that runs it, the failing assertion>

## Root cause

<file:line and one paragraph>

## Simplest fix

<the smallest change that makes the test pass without breaking a rule>

## Alternatives rejected

<each one with the reason>

## Risk

<what else the fix touches; what a reviewer should check>
```

```bash
gh issue edit <N> --remove-assignee @me
```

Leave the label at `bug:triage`. Moving it to `bug:ready` is the
maintainer's decision after reading the report.

## Stopping early

If you stop before the report is posted — out of context, told to stop,
waiting on the maintainer's answer about the slow lane — push whatever is on
`bug/<N>-repro`, leave one comment headed `## Handoff` with Done, Not done,
Findings and Blocked on, and unassign yourself. Findings is where a partial
root cause or a rejected hypothesis goes so the next agent does not redo it.
