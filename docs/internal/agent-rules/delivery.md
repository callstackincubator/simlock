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
| `bug:blocked`      | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |
| `feature:spec`     | spec session, on creation           | Business or technical spec in progress.                   |
| `feature:ready`    | maintainer                          | Business sections and ADRs accepted; agents do the rest.  |
| `feature:planned`  | spec session, on split              | Split into tasks. Never picked up itself.                 |
| `feature:blocked`  | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |
| `task:draft`       | spec session, on creation           | Scope written; technical spec, approval, or deps missing. |
| `task:ready`       | automation, or maintainer           | An agent may implement it.                                |
| `task:blocked`     | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |

Two labels sit outside that scheme. `flaky-test` marks a bug that names a
test failing without a code change (testing rule 5). `needs-hardware` marks
a pull request parked because a Done when line needs a real simulator or
emulator run that has not happened (rule 16).

Transitions per kind:

- **request**: `new` until closed. Closed as not planned, or as completed with
  a comment naming the feature it became.
- **bug**: `new` → `triage` → `ready`, with `needs-info` as a side-trip that
  returns to `triage` when the reporter answers.
- **feature**: `spec` → `ready` or `planned`, and `ready` → `planned` when
  the delivering agent splits it. Both end at closed.
- **task**: `draft` → `ready`, and back to `draft` if the approval, the
  technical spec, or a closed dependency goes away.
- **any kind**: `triage` or `ready` → `blocked` when an agent stops on a
  blocker it names in its handoff. The maintainer clears it by re-adding the
  label it came from.

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
   One delegation follows from `feature:ready`: the maintainer has accepted
   the business sections and every ADR the feature links, and that is the
   approval for the rest. An agent delivering it may write the feature's
   task specs, split it, and tick each task's approval box, then deliver
   the tasks as they turn ready. A new decision that needs an ADR, or a
   comment that would change the spec, is not covered: the agent stops and
   hands off.

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
   wrong, or leaves open something rule 3 does not let an agent close as an
   assumption, the handoff says "spec needs: ..." and the agent stops; it
   does not amend the spec in the comment. One handoff per stop,
   no progress log — an agent comments when it stops, not while it works.
   If Blocked on is anything but "nothing", the agent also moves the issue
   to `<kind>:blocked`, so the next agent does not walk into the same wall;
   the maintainer clears it by re-adding the label it came from.

3. **The body is the spec. Comments are discussion. Assumptions are
   proposals.** Whoever implements an issue reads its body, the documents it
   links, [always-in-scope.md](always-in-scope.md), the latest `## Handoff`
   comment if there is one, and for a bug the triage report — never the rest
   of the comment thread.
   A comment changes nothing until a spec session folds it into the body. The
   body is cumulative: sections are added and amended in place, never
   restated in comments, and GitHub's edit history is the record of what
   changed.
   A small gap that the body, the rules in this directory, the accepted ADRs
   and `always-in-scope.md` all leave open — a wording, an order, a bound
   the spec implies — is closed by the implementer the conservative way and
   recorded as one `Assumption:` line under `## Assumptions` in the PR body.
   An assumption is a visible proposal that the spec review checks and the
   maintainer may reject, never a change to the spec: the body stays the
   spec. Delivery stops for a person only when building would contradict the
   body, a rule or an accepted ADR, or would change behaviour a user sees in
   a way nobody decided.

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
   as claims. It need not repeat what `always-in-scope.md` lists, and a small
   gap it leaves is an assumption, not a question (rule 3). A task with an
   empty technical section is `task:draft` no matter what anyone says in a
   comment. Before a task's approval box is ticked, or a feature delivered as
   one PR gets `feature:ready`, the spec session has the `check-spec` skill
   read the body as posted, with a fresh context, and fixes in the body what
   it reports.

8. **Triage produces a report, not a fix.** An agent working `bug:triage`
   reproduces the bug as a failing test whose title states the claim the
   test proves, finds the root cause, and posts one comment with exactly
   these sections: *Reproduction*, *Root cause* (with file and line),
   *Simplest fix*, *Alternatives rejected* (at most three, one line each),
   *Risk* (at most three bullets), and *Side findings* when there are any. The root cause says first whether this is a defect
   (Simlock does the wrong thing) or a gap (Simlock does nothing wrong and
   something is missing); for a gap the test's expectation is a proposal
   and the report says so; `bug:ready` on a gap accepts that proposal. A
   separate problem found on the way is opened as
   its own `bug:new` issue and listed under Side findings, not described in
   the report. It pushes the failing test to a
   `bug/<number>-repro` branch and opens no pull request. It then unassigns
   itself. If it cannot reproduce, it moves the issue to `bug:needs-info`,
   says exactly what is missing, and unassigns itself.

9. **Done is defined per kind.** A task or bug is done when the pull request
   that closes it is merged; for a bug the failing test from triage is the
   regression test and must be in that PR. A `feature:ready` issue is done
   when its PR is merged and the PR body walks every completion condition.
   A `feature:planned` issue is done when every sub-issue is closed. The
   delivering agent merges its own PR, but only through the gate in rule
   15.
   Verification is part of delivery, not a step after it: every task PR
   walks its Done when, and the PR that closes the last open sub-issue also
   walks the parent's Completion conditions. The maintainer closes the
   feature.

10. **ADR status follows the feature.** A decision made during a spec session
    that constrains more than one task, or would be expensive to reverse,
    becomes an ADR. It is *Accepted — not yet implemented* from the moment
    the feature leaves `feature:spec`, and flips to *Accepted* when the
    feature closes. A feature does not leave `feature:spec` while any ADR it
    links is still *Proposed*.

11. **The branch is named from the issue, and only from the issue.** Work on
    issue `<n>` of kind `<kind>` happens on `<kind>/<n>` — `task/118`,
    `bug/79`, `feature/88` — and a bug's reproduction lives on
    `bug/<n>-repro`. No slug, no author prefix, no date. Given an issue you
    can name its branch without looking; given a branch you can name its
    issue by reading the second path segment. A PR from such a branch must
    close that issue and no other.

12. **Everything an agent writes on an issue or a PR is short and plain.**
    Lead with the conclusion. Short sentences, common words, no filler, no
    narration of what the agent did or considered. Evidence goes in a code
    block or a link, never in prose. Cut anything that does not change the
    reader's next decision. Budgets, counted outside code blocks: a triage
    report 300 words, a handoff 150, a PR body 200 plus its checklist, its
    Assumptions and its Review section, a "Spec updated" comment one line,
    the review notes comment one line per note. Text over budget is cut before it is
    posted, not excused after. Do not restate the issue body: confirm or
    correct what it says, then add only what is new. Every comment, issue
    body, and PR body an agent writes ends with the line
    `*Written by an agent.*`, those exact characters — people and automation
    use it to tell agent text from a person's, since agents post under a
    maintainer's account.

13. **Assume every agent is in a worktree.** Several agents share one clone
    through `git worktree`, so a branch may already be checked out somewhere
    else and `git switch` to it will fail. Create branches in whatever
    checkout you have, push them, and treat `origin/<branch>` as the truth;
    to continue a branch another checkout holds, branch from
    `origin/<branch>` rather than switching to it. Nothing depends on which
    worktree a branch was made in.

14. **A PR is marked ready only after two reviews, and every blocking
    finding is answered.** Review is part of delivery in the same way
    verification is (rule 9). The PR opens as a draft as soon as the spec's
    tests are committed red, so CI runs from the first push and the PR body
    can carry the work's status. It leaves draft only after two reviews of
    the diff against `main`, each by a fresh sub-agent defined in
    `.claude/agents/`, whose frontmatter pins the model and effort (never a
    smaller model chosen for speed), and each blind to the implementer and
    to the other reviewer. `.agents/scripts/review-inputs.sh` builds what each
    one reads.
    The *spec review* gets the issue body, its parent feature, the ADRs it
    names, the files under Rules in play, `always-in-scope.md`, a bug's
    triage report, the PR body's `Assumption:` lines, the diff, and every
    change made to the spec's tests since they were committed red — nothing
    else, and never the rest of the PR body. It answers: is every line of
    Scope and Done when delivered, does the diff do anything the spec did not
    ask for (what `always-in-scope.md` lists counts as asked for), does every
    test title state a claim the spec made, does any change after red leave
    a line of the spec unproven, and is every assumption conservative and
    consistent with the spec. It reads; it does not run anything. A diff
    that only adds or changes ADRs gets this review alone, judged as a design
    record rather than against Completion conditions.
    The *code review* gets every file under this directory, the ADR index,
    and the diff — never the issue. It answers, in this order: for each
    changed function, what input, state, or interleaving makes it wrong; and
    does the diff break a rule in this directory. It works in its own
    worktree and proves a claim with the affected test file only. It may
    break code to see what stays green (testing rules 2 and 3) at most three
    times, on its riskiest claims, and restores the tree afterwards. It does
    not run `pnpm check`, `pnpm mutate`, the whole fast e2e suite, the
    console lane or the slow lane: the implementer and CI run those.
    Each review returns findings, one per defect: a claim, the evidence as
    `file:line` or a command and its output, and *blocking* or *note*. A
    finding is blocking when it breaks behaviour, leaves wrong state, or
    breaches a rule, an accepted ADR or the spec; anything else is a note. A
    finding needs a concrete failure or a named cost and who pays it; a diff
    touching a file the spec did not list is a note unless a user would see
    the difference. Whether CI is green is never a finding: CI proves it, and
    the gate checks it (rule 15).
    A blocking finding is a claim, not a fact: it is verified against the
    code before anyone acts on it. A confirmed one is fixed and the review
    that raised it runs again on the new diff; a rejected one is listed in
    the PR body under `## Review`, one line each, tagged `spec:` or `code:`
    for the review that raised it, with the reason, so the maintainer sees
    what was overruled and by whom. Accepted findings are not narrated.
    Notes are not verified and never start a round: after the last round
    they go out once, as one comment on the PR, or as a `bug:new` issue when
    one is a separate piece of work. Two rounds at most: a blocking finding
    still confirmed after the second round means the agent stops and hands
    off with the finding under Findings (rule 2), leaving the PR in draft. A
    PR from a person gets the same two reviews when the maintainer asks for
    them.

15. **An agent merges only through the gate.** `.agents/scripts/merge-pr.sh`
    is the one place a delivery PR is merged from; agents may not run
    `gh pr merge` themselves. The script merges only a ready PR with no
    `needs-hardware` label, a `## Review` section and no "spec needs" line,
    green CI, and no conflict. Before calling it the agent also checks what
    the script cannot read: no blocking finding is open, and every mutant
    `pnpm mutate` left alive is explained in the PR body. Anything short of
    that parks the issue with a handoff and leaves the PR for the
    maintainer.

16. **Real devices run one lane at a time, through the script.** The slow
    e2e lane starts real simulators and emulators on a shared machine, and
    two lanes at once produce timeouts that look like bugs. Agents run it
    only through `scripts/slow-e2e.sh`, which holds a machine-wide lock,
    runs detached so no tool time limit kills it halfway, and logs to a
    file. It runs beside the two reviews, on the commit they review, not
    after them. A failure joins the review's fixes in one fix run, and when
    that run changed more than docs, the lane runs again beside the second
    round. With a person present the agent
    asks before starting it. Unattended, it runs when the lock is free; when
    the lock stays busy or the machine has no devices, the PR gets
    `needs-hardware` and waits for the maintainer.

## Procedures

**Claiming work.** Find it, claim it, branch, and finish with a PR that
closes the issue:

```bash
gh issue list --search 'label:bug:ready,feature:ready,task:ready no:assignee'
gh issue edit <n> --add-assignee @me
.agents/scripts/worktree.sh task/<n>    # or bug/<n>, feature/<n>; resumes origin/<branch>
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

The repo's own skills encode these procedures; use them rather than
retyping the steps. `deliver` is the orchestrator: it claims, then hands
each stage to a forked skill — `implement`, `review`, `verify-hardware` —
that runs on the model its frontmatter pins and returns a fixed report.
`spec-session` and `triage-bug` cover the rest; `spec-session` ends its
technical and split modes with the forked `check-spec` (rule 7).

## Automation

`.github/workflows/issue-state.yml` is the one place that enforces the label
rules mechanically, so nobody has to remember them:

- Adding a `<kind>:<state>` label removes any other one on the issue. Every
  transition is therefore a single add.
- A `task:draft` issue becomes `task:ready` on its own when its approval box
  is ticked, its Technical spec section is filled in, and every issue under
  Depends on is closed. It is re-evaluated whenever its body changes and
  whenever an issue it depends on closes.
- A `task:ready` issue with no assignee goes back to `task:draft` when the
  approval box is unticked, the technical spec is emptied, or a dependency
  is reopened. A claimed task is left alone.
- A comment by the reporter on a `bug:needs-info` issue moves it back to
  `bug:triage`, reopening the issue if it had been closed. Two weeks of
  silence closes it as not planned.
- When the last sub-issue of a `feature:planned` issue closes, the workflow
  comments that the feature can be closed once the completion conditions
  hold.
- A feature closed as completed closes the `request:new` issue it names on
  its `Request:` line, with a comment pointing at the feature.
- A pull request closed without merging releases the claim on every issue
  its body closes, with a comment. The label is left as it was.
- A claim on a `*:ready` issue with no comment, label change, or commit on
  `<kind>/<n>` for three days is released, with a comment.
- A pull request from a `<kind>/<n>` branch fails its check unless its body
  closes `#<n>` and closes nothing else.

The judgment calls stay manual by design: `bug:new` → `bug:triage`,
`bug:triage` → `bug:ready`, and `feature:spec` → `feature:ready`. The
approval box on each task is the maintainer's click, except on the tasks of
a `feature:ready` feature, where the delivering agent ticks it (rule 1).
