# How work flows

GitHub Issues is the specification and the queue. An issue's body is what an
agent builds against; its label is the only thing that tells an agent whether
it may act. This page is the maintainer's manual for that model. The binding
rules are in [agent-rules/delivery.md](agent-rules/delivery.md); this page
explains how they fit together in practice.

## The model in five sentences

Every issue carries exactly one `<kind>:<state>` label, and the prefix is the
kind. Agents act only on `bug:triage`, `bug:ready`, `feature:ready` and
`task:ready`; everything else is either an unread claim from outside or an
unfinished spec. The body is the spec and comments are discussion, so a
comment changes nothing until a spec session folds it into the body. A
reporter's issue is never rewritten: bugs are triaged in a comment, and a
feature that came from a request is a new issue the maintainer owns. What
happens after `ready` is read from GitHub itself — assignee, linked pull
request, closed — not from a label. The branch for issue `<n>` is always
`<kind>/<n>`, so an issue names its branch and a branch names its issue.

| Label             | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `request:new`     | Inbox. Never picked up, body never edited.               |
| `bug:new`         | Reported. Nobody has looked yet.                         |
| `bug:triage`      | An agent may reproduce it and write the triage report.   |
| `bug:needs-info`  | Could not reproduce. Waiting on the reporter.            |
| `bug:ready`       | An agent may fix it.                                     |
| `bug:blocked`     | Waiting on the maintainer to clear a blocker.            |
| `feature:spec`    | Business or technical spec in progress.                  |
| `feature:ready`   | No sub-issues; one PR delivers the whole feature.        |
| `feature:planned` | Split into tasks. Never picked up itself.                |
| `feature:blocked` | Waiting on the maintainer to clear a blocker.            |
| `task:draft`      | Scope written; technical spec, approval or deps missing. |
| `task:ready`      | An agent may implement it.                               |
| `task:blocked`    | Waiting on the maintainer to clear a blocker.            |

## A bug, from report to fix

1. Someone opens a bug through the form. It arrives as `bug:new`. Nothing
   happens.
2. The maintainer reads it. If it sounds real, they add `bug:triage`. That is
   the whole delegation.
3. An agent running `triage-bug` assigns itself, reproduces the bug as a
   failing test whose title states the claim, finds the root cause, pushes
   only the test to `bug/<n>-repro`, and posts one comment with five
   sections: Reproduction, Root cause, Simplest fix, Alternatives rejected,
   Risk. It opens no pull request, and it unassigns itself when done.
4. If it could not reproduce, it swaps the label to `bug:needs-info` and says
   exactly what is missing. A reply from the reporter moves the issue back to
   `bug:triage` on its own; two weeks of silence closes it.
5. The maintainer reads the report. Agree: add `bug:ready`. Disagree: reply
   with what is wrong and re-add `bug:triage`; the next agent starts from
   that reply. When the report says the bug is a gap rather than a defect,
   `bug:ready` also accepts the shape the report proposes — the advisory
   code, the message, the field. To reject the shape but keep the
   reproduction, reply and re-add `bug:triage`.
6. An agent running `deliver` claims the `bug:ready` issue, creates `bug/<n>`
   from the repro branch, and opens a PR that closes the issue. The triage test is now
   the regression test. Merge closes the bug.

## A feature, delivered as one PR

1. The maintainer creates a `feature:spec` issue, or an outside request
   arrives as `request:new` and the maintainer decides to take it up. Nothing
   happens to a request by default.
2. First spec session. The agent interviews the maintainer and writes the
   business half of [templates/feature.md](templates/feature.md): Problem,
   Who it is for, Outcome, Non-goals, Completion conditions, Open questions.
   It says what a user can do afterwards, never how. If the feature came from
   a request, the session creates the feature issue, links it to the request,
   and comments on the request so the reporter knows where to look. The
   request stays open until the feature ships.
3. Discussion happens, on the feature or on the request, in comments. Nobody
   edits the body by hand.
4. Second spec session. The agent first lists every comment posted since the
   body was last edited, on both threads, as a set of proposed changes; the
   maintainer accepts or rejects each. Then it interviews for the Technical
   spec section. Any decision that constrains more than one future change or
   would be expensive to reverse becomes an ADR at _Proposed_, listed under
   Decisions. The session ends by editing the body and leaving a one-line
   "Spec updated" comment.
5. Once Open questions is empty and every linked ADR is accepted, the
   maintainer adds `feature:ready`. The ADRs move to _Accepted — not yet
   implemented_.
6. An agent running `deliver` claims it, works on `feature/<n>`, and opens a
   PR whose body walks every completion condition. Merge closes the feature, and its ADRs flip to
   _Accepted_.

## A feature, split into tasks

Steps 1 to 4 are the same, but the second session ends differently: instead
of a Technical spec section on the feature, it produces sub-issues.

5. Each task is a native sub-issue of the feature, labelled `task:draft`, with
   a body from [templates/task.md](templates/task.md): Scope, Technical spec,
   Done when, Out of scope, Depends on, and an approval checkbox. The feature
   becomes `feature:planned` and keeps only its business spec, Decisions and
   the task list.
6. The maintainer ticks the approval box on each task, once, at planning
   time. From then on the automation promotes a task to `task:ready` the
   moment its box is ticked, its Technical spec has content, and every issue
   under Depends on is closed. Nobody re-reads the dependency graph by hand.
7. Agents claim `task:ready` issues one PR each, on `task/<n>`. As tasks close, the ones they
   unblocked become ready on their own.
8. Verification is part of delivery. Every task PR walks its Done when, and
   the PR that closes the last open sub-issue also walks the feature's
   Completion conditions. When that last sub-issue closes, the automation
   comments on the feature, and the maintainer closes it. If the feature
   came from a request, the request closes on its own with a pointer to the
   feature.

## Handoffs between agents

An agent that stops before its PR is merged — out of context, blocked, or
told to stop — unassigns itself and leaves one comment headed `## Handoff`
with four sections: Done, Not done, Findings, Blocked on. The branch is the
other half of the handoff: because it is always `<kind>/<n>`, the next agent
knows where the commits are without being told. A handoff records the state
of the work, never a change to the spec; if the work showed the spec is
wrong, the handoff says so and the maintainer runs a revise spec session.
Agents do not post progress updates, only handoffs, so the one comment that
matters is easy to find. A handoff that names a blocker also moves the issue
to `<kind>:blocked`, so nobody picks it up until the maintainer re-adds the
label it came from. A claim that goes silent — no comment, label change, or
commit for three days — or whose PR is closed without merging is released by
the automation, so a crashed agent cannot hold an issue forever.

Everything an agent writes on an issue or a PR — report, handoff, spec, PR
body — is short and plain: conclusion first, short sentences, common words,
evidence in code blocks, nothing that does not change the reader's next
decision. Each has a word budget in the rule, and each ends with the line
`*Written by an agent.*`, because agents post under a maintainer's account
and readers and automation need to tell the two apart.

## What is automated and what is not

The workflow in `.github/workflows/issue-state.yml` handles the transitions
that are mechanical: adding a state label removes the previous one, so every
transition is a single add; `task:draft` becomes `task:ready` when approved,
specified and unblocked, and goes back when that stops being true; a
reporter's reply moves `bug:needs-info` back to `bug:triage` and reopens the
issue if needed; a silent `bug:needs-info` closes after two weeks; a feature
whose last sub-issue closed gets a note to close it; a completed feature
closes its request; a PR closed without merging or a claim silent for three
days releases the claim; a PR from a `<kind>/<n>` branch must close `#<n>`
and nothing else. The repo's
skills — `spec-session`, `triage-bug`, `deliver` — handle the transitions an
agent makes as part of its own procedure.

Four transitions are judgments and stay manual on purpose: `bug:new` to
`bug:triage`, `bug:triage` to `bug:ready`, `feature:spec` to
`feature:ready`, and the approval box on each task. Each is one click.

## Where ADRs fit

A feature answers _what_ and _why_ in business terms. An ADR answers _how_,
but only for choices that constrain more than one task or would be expensive
to reverse. A task answers _how_ for exactly one PR. Most features never need
an ADR; the ones that fix a protocol shape or an ownership model do. An ADR
is born in a spec session, is _Proposed_ while the feature is `feature:spec`,
_Accepted — not yet implemented_ while the feature is open, and _Accepted_
when it closes. See [adr/README.md](adr/README.md).

## Pointers

- Rules: [agent-rules/delivery.md](agent-rules/delivery.md)
- Templates: [templates/feature.md](templates/feature.md),
  [templates/task.md](templates/task.md)
- Reporter forms: `.github/ISSUE_TEMPLATE/`
- Labels: `.github/labels.json`, synced by `.github/workflows/labels.yml`
- Automation: `.github/workflows/issue-state.yml`
- Skills: `.claude/skills/spec-session`, `.claude/skills/triage-bug`,
  `.claude/skills/deliver`
