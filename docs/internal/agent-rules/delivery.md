# Agent rules: delivery

Rules for how work enters and leaves this repo. GitHub Issues is both the
specification and the queue: an issue's body is the spec an agent builds
against, and its label is the only signal that tells an agent whether it may
act. These rules are binding in the same way the other files here are — an
agent that picks up an issue it was not entitled to, or that implements from
a comment thread instead of the body, has made an error even if the code is
good.

## Kinds and labels

Every issue carries exactly one label of the form `<kind>:<state>`. The
prefix is the kind; there is no separate kind label. An issue with zero or
two such labels is in an invalid state and must be corrected before anything
else happens to it.

| Label              | Set by                              | Meaning                                                   |
| ------------------ | ----------------------------------- | --------------------------------------------------------- |
| `request:new`      | feature request form                | Inbox. Never picked up, body never edited.                |
| `bug:new`          | bug report form                     | Reported. Nobody has looked yet.                          |
| `bug:triage`       | maintainer                          | An agent may reproduce it and write the triage report.    |
| `bug:needs-info`   | triage agent                        | Could not reproduce. Waiting on the reporter.             |
| `bug:ready`        | maintainer, after the triage report | An agent may fix it.                                      |
| `feature:spec`     | spec session, on creation           | Business or technical spec in progress.                   |
| `feature:ready`    | maintainer                          | No sub-issues; one PR delivers the whole feature.         |
| `feature:planned`  | spec session, on split              | Split into tasks. Never picked up itself.                 |
| `task:draft`       | spec session, on creation           | Scope written; technical spec, approval, or deps missing. |
| `task:ready`       | automation, or maintainer           | An agent may implement it.                                |

Transitions per kind:

- **request**: `new` until closed. Closed as not planned, or as completed with
  a comment naming the feature it became.
- **bug**: `new` → `triage` → `ready`, with `needs-info` as a side-trip that
  returns to `triage` when the reporter answers.
- **feature**: `spec` → `ready` or `planned`. Both end at closed.
- **task**: `draft` → `ready`.

Everything after `ready` is read from GitHub itself, not from a label:
in progress means an assignee is set, in review means a linked pull request
is open, done means closed as completed.

## Rules

1. **An agent acts only on `bug:triage`, `bug:ready`, `feature:ready`, and
   `task:ready`.** Nothing else is work. A `request:new` or `bug:new` issue
   is a claim from outside that a maintainer has not yet looked at; a
   `feature:spec` or `task:draft` issue is a spec that is not finished. Agents
   do not label their way into work: only a maintainer, or the automation a
   maintainer configured, moves an issue to a state an agent may act on.

2. **The assignee is the claim, and a handoff is how a claim is released.**
   Before doing anything on an issue an agent assigns itself, and it never
   touches an issue that already has an assignee. This is the one
   cross-agent lock in the model; there is no other. An agent that stops
   before the PR is merged unassigns itself and leaves exactly one comment
   headed `## Handoff` with four sections: *Done* (what is on the branch and
   how it was verified), *Not done* (what remains, in the spec's own terms),
   *Findings* (what was learned that is not in the spec and the next agent
   would otherwise rediscover), *Blocked on* (who or what, or "nothing").
   A handoff is state, never spec: if the work revealed that the body is
   wrong or incomplete, the handoff says "spec needs: ..." and the agent
   stops; it does not amend the spec in the comment. One handoff per stop,
   no progress log — an agent comments when it stops, not while it works.

3. **The body is the spec. Comments are discussion.** Whoever implements an
   issue reads its body, the documents it links, the latest `## Handoff`
   comment if there is one, and for a bug the triage report — never the rest
   of the comment thread.
   A comment changes nothing until a spec session folds it into the body. The
   body is cumulative: sections are added and amended in place, never
   restated in comments, and GitHub's edit history is the record of what
   changed.

4. **Every spec session starts by reconciling.** Before writing anything, the
   session fetches every comment created after the body's `lastEditedAt`, on
   the issue itself and on its linked request if it has one, and lists what
   those comments change about the spec. The maintainer accepts or rejects
   each item. Only then does the session write the section it was started
   for. It ends by editing the body and leaving one short comment saying
   which sections moved, so a reader of the thread can see where the spec
   last caught up.

5. **A reporter's issue is never rewritten.** Bug reports and feature requests
   arrive through the issue forms and stay in the reporter's words. Triage
   is a comment on the bug. A feature that came from a request is a new
   issue authored by the maintainer, linked from and to the request; the
   request stays open, and closes with the feature.

6. **A feature spec describes outcomes, not implementation.** The business
   sections of `docs/internal/templates/feature.md` say what a user can do afterwards
   that they could not before, and how anyone would check it. An
   implementation detail belongs there only when it *is* a requirement — "no
   inbound port on the worker" is an outcome; "use a WebSocket" is not.
   Implementation lives in the technical section, in an ADR, or in a task.

7. **A task carries both halves.** A task's Scope is the slice of the parent's
   outcome it delivers; its Technical spec is what a delivery agent needs to
   build it without asking: modules touched, contract and event changes,
   which rules in this directory are in play, and the tests to write phrased
   as claims. A task with an empty technical section is `task:draft` no
   matter what anyone says in a comment.

8. **Triage produces a report, not a fix.** An agent working `bug:triage`
   reproduces the bug as a failing test whose title states the claim,
   finds the root cause, and posts one comment with exactly these sections:
   *Reproduction*, *Root cause* (with file and line), *Simplest fix*,
   *Alternatives rejected*, *Risk*. It pushes the failing test to a
   `bug/<number>-repro` branch and opens no pull request. It then unassigns
   itself. If it cannot reproduce, it moves the issue to `bug:needs-info`,
   says exactly what is missing, and unassigns itself.

9. **Done is defined per kind.** A task or bug is done when the pull request
   that closes it is merged; for a bug the failing test from triage is the
   regression test and must be in that PR. A `feature:ready` issue is done
   when its PR is merged and the PR body walks every completion condition.
   A `feature:planned` issue is done when every sub-issue is closed *and* an
   agent has proven the completion conditions against main, usually by an
   end-to-end run reported in a comment; the maintainer closes it.

10. **ADR status follows the feature.** A decision made during a spec session
    that constrains more than one task, or would be expensive to reverse,
    becomes an ADR. It is *Accepted — not yet implemented* from the moment
    the feature leaves `feature:spec`, and flips to *Accepted* when the
    feature closes. A feature does not leave `feature:spec` while any ADR it
    links is still *Proposed*.

## Procedures

**Claiming work.** Find it, claim it, branch, and finish with a PR that
closes the issue:

```bash
gh issue list --search 'label:bug:ready,feature:ready,task:ready no:assignee'
gh issue edit <n> --add-assignee @me
git switch -c task/<n>-<slug>        # or bug/<n>-<slug>, feature/<n>-<slug>
```

The PR body contains `Closes #<n>`. For a bug, branch from `bug/<n>-repro`
when it exists so the triage test is carried forward.

**Finding triage work.**

```bash
gh issue list --label bug:triage --search 'no:assignee'
```

**Moving a label.** Add the new one and remove the old one in the same
command, so the one-label invariant never breaks in between:

```bash
gh issue edit <n> --add-label bug:needs-info --remove-label bug:triage
```

The repo's own skills (`spec-session`, `triage-bug`, `deliver`) encode these
procedures; use them rather than retyping the steps.
