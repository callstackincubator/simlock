---
name: triage-bug
description: Triage a bug:triage issue — reproduce it as a failing test, find the root cause, and post a report proposing the simplest fix, without fixing it. Use when the user says "triage #N", "triage the next bug", or points at an issue labelled bug:triage.
---

# Triage a bug

You produce a report, not a fix. Rule 8 in `docs/internal/agent-rules/delivery.md`
defines the report; `docs/internal/agent-rules/testing.md` defines what a reproduction
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

Read the body and the comment thread. The reporter may already have done
part of the analysis; the report confirms or corrects what the body says
and adds only what is new. Write a test in the project that can prove it — a unit test when the behaviour is in-process, an e2e test when it
needs a daemon. The test must fail on a named assertion, not a timeout. Run
it and keep the failing output.

The title is the claim the test proves: the bug's claim narrowed to what
this process can observe. What the OS or a tool outside Simlock does is
evidence for the report, never part of the title. "Reports assets that
outlive `simctl runtime delete`" claims a delete the test never runs;
"reports downloaded runtime assets for runtimes not in the catalog" is what
the body shows.

Assert the whole claim. Every case the fixture sets up appears in the
expectation, so a fix that does less than the report proposes fails the
test. Two orphan builds in the fixture means two builds in the assertion.

Read-only inspection of the host — listing a directory, reading a plist,
running `df` — is fine and often the fastest evidence. Say what you read.
Do not run the slow e2e lane or anything that starts real simulators or
emulators without asking the maintainer first. If reproduction needs it,
ask; if the answer is no, say so in the report and go as far as the fake
driver allows.

If you cannot reproduce after a genuine attempt:

```bash
gh issue comment <N> --body "<what you tried, and exactly what information would let you reproduce it>

*Written by an agent.*"
gh issue edit <N> --add-label bug:needs-info --remove-label bug:triage --remove-assignee @me
```

and stop.

## 3. Find the root cause

Follow the failing assertion back to the line that makes it fail. Name the
file and line. Distinguish the root cause from the place the symptom shows
up.

Say first which of three things this is:

- **Defect**: Simlock does the wrong thing. The test's expectation is the
  right behaviour.
- **Gap**: Simlock does nothing wrong and something is missing. The test's
  expectation is a proposal — say so in Reproduction, and put the shape it
  pins (a code, a message, a field) under Simplest fix so the maintainer can
  reject the shape without rejecting the reproduction. A gap that needs more
  than one PR is a feature: recommend a spec session and stop there.
- **Decision**: the code does what an ADR says and the ADR is wrong. Say so;
  that bug becomes a feature with a superseding ADR, not a fix.

## 4. Push the reproduction

```bash
git fetch origin
git switch -c bug/<N>-repro origin/main
git add <test files only>
git commit -m "test: reproduce #<N> — <claim>"
git push -u origin bug/<N>-repro
```

Only the test goes on this branch. No fix, no pull request. You are
probably in a worktree (rule 13): branch from `origin/main`, not `main`,
and if `bug/<N>-repro` is already held by another checkout, branch from
`origin/bug/<N>-repro` under a temporary name and push to the real one:

```bash
git switch -c wip/<N>-repro origin/bug/<N>-repro && git push origin HEAD:bug/<N>-repro
```

## 5. Side findings

A separate problem found on the way — a stale doc, a wrong error reason,
another bug — is its own issue, not a paragraph in the report:

```bash
gh issue create --label bug:new --title "<what is wrong, in one line>" --body "<what you saw, file:line, found while triaging #<N>>

*Written by an agent.*"
```

List each one as a link under Side findings. The maintainer decides what
happens to it.

## 6. Report and release

If a person is present in this session, show the text first and wait for a
yes before posting. Running unattended, post directly.

Post one comment with exactly these sections, then unassign. If a report
already exists on the thread, yours replaces it: make the first line
`Supersedes the report above.` so the maintainer knows which one is current.

```markdown
## Reproduction

<test file and title, the command that runs it, the failing assertion>

## Root cause

<file:line and one paragraph>

## Simplest fix

<the smallest change that makes the test pass without breaking a rule>

## Alternatives rejected

<at most three, one line each: the alternative, then why not>

## Risk

<at most three bullets: what a reviewer should check>

## Side findings

<one link per issue opened, or omit the section>

_Written by an agent._
```

The report exists for one decision: `bug:ready` or not. Rule 12 applies:
300 words outside code blocks, conclusion first, short sentences, plain
words, evidence in code blocks. Root cause is one paragraph. If it runs
long, cut what does not change the decision.

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
If you are waiting on the maintainer, also move the issue to `bug:blocked`
so no other agent starts the same triage; the maintainer re-adds
`bug:triage` when the answer is in:

```bash
gh issue edit <N> --add-label bug:blocked --remove-label bug:triage
```
