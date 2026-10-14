# Agent rules: delivery

How work enters and leaves this repo. GitHub Issues is both the
specification and the queue: an issue's body is the spec an agent builds
against, and its label alone tells an agent whether it may act. Picking up
an issue you were not entitled to, or building from a comment thread instead
of the body, is an error even when the code is good.

## Kinds and labels

Every issue carries exactly one label of the form `<kind>:<state>`; the
prefix is the kind. An issue with zero or two such labels is invalid: correct
it before anything else happens to it.

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
| `task:draft`       | spec session, on creation           | Scope written; technical spec or its spec check missing.  |
| `task:ready`       | spec session, after the spec check  | An agent may implement it once its Depends on allow.      |
| `task:blocked`     | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |

Two labels sit outside that scheme. `flaky-test` marks a bug that names a
test failing without a code change (testing rule 5). `needs-hardware` marks
a pull request parked because a Done when line needs a slow-lane run that
has not happened (rule 16).

Transitions per kind:

- **request**: `new` until closed. Closed as not planned, or as completed with
  a comment naming the feature it became.
- **bug**: `new` → `triage` → `ready`, with `needs-info` as a side-trip that
  returns to `triage` when the reporter answers.
- **feature**: `spec` → `ready` or `planned`, and `ready` → `planned` when
  the delivering agent splits it. Both end at closed.
- **task**: `draft` → `ready` when its spec check passes, and back to
  `draft` if the technical spec is emptied or the maintainer moves it.
- **any kind**: `triage` or `ready` → `blocked` when an agent stops on a
  blocker it names in its handoff. The maintainer clears it by re-adding the
  label it came from.

Everything after `ready` is read from GitHub itself, not from a label:
in progress means an assignee is set, in review means a linked pull request
is open, done means closed as completed.

## Rules

1. **An agent acts only on `bug:triage`, `bug:ready`, `feature:ready`, and
   `task:ready`.** Nothing else is work. Agents never label their way into
   work: only a maintainer, automation a maintainer configured, or the spec
   session that wrote a task and saw its spec check pass (rule 7) moves an
   issue to a state an agent may act on. The maintainer's say on a task is
   the split interview; they can move a task back to `task:draft` at any
   time. A `task:ready` task runs once every issue under its Depends on is
   closed, or is a task of the same feature whose PR passed review.
   `feature:ready` delegates one thing: the maintainer accepted the business
   sections and every ADR the feature links, and that approves the rest. An
   agent delivering it may write the task specs, split the feature, set
   each checked task `task:ready`, and deliver the tasks in their Depends
   on order. A new decision that needs an ADR, or a comment that would
   change the spec, is not covered: the agent stops and hands off.

2. **The assignee is the claim, and a handoff is how a claim is released.**
   Before doing anything on an issue an agent assigns itself, and it never
   touches an issue that already has an assignee. This is the only
   cross-agent lock. An agent that stops
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
   proposals.** What an implementer reads, and how it closes a small gap as
   an `Assumption:` line, is in [coding.md](coding.md) rules 1 and 2.
   The body is cumulative: sections are added and amended in place, never
   restated in comments, and GitHub's edit history is the record of what
   changed. When delivery stops for a person, the agent that asked folds the
   person's answer in before work resumes, so every later agent reads it as
   spec: into a task or feature body, as a line in the section it settles
   and a Tests line that pins it; for a bug, whose body stays the reporter's
   (rule 5), as one comment headed `## Decision`, read with the triage
   report. When the delivery orchestrator decides such a question itself,
   rather than stop (the `deliver` skill), it folds its own choice in the
   same way, marked as pending the maintainer, and tells the maintainer in
   a PR comment; a later answer that differs is a fix run or a new task.

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
   build it without asking: the facts it rests on, modules touched,
   contract and event changes, which rules in this directory are in play,
   and the tests to write phrased as claims. A fact is what existing code,
   another tool or the machine does today; each cites the line or the
   command output it was read from, never a summary. It need not repeat
   what `always-in-scope.md` lists, and a small gap it leaves is an
   assumption, not a question (rule 3). A task with an empty technical
   section is `task:draft` no matter what anyone says in a comment. Before
   a task gets `task:ready`, or a feature delivered as one PR gets
   `feature:ready`, the spec session has the `check-spec` skill read the
   body as posted, with a fresh context, and fixes in the body what it
   reports.

8. **Triage produces a report, not a fix.** An agent working `bug:triage`
   reproduces the bug as a failing test whose title states the claim the
   test proves, finds the root cause, and posts one comment with exactly
   these sections: *Reproduction*, *Root cause* (with file and line),
   *Simplest fix*, *Alternatives rejected* (at most three, one line each),
   *Risk* (at most three bullets), and *Side findings* when there are any. The root cause says first whether this is a defect
   (the code does the wrong thing) or a gap (nothing is wrong and something
   is missing); for a gap the test's expectation is a proposal
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
   Verification is part of delivery, not a step after it ([coding.md](coding.md)
   rule 5). The maintainer closes the feature.

10. **ADR status follows the feature.** A decision made during a spec session
    that constrains more than one task, or would be expensive to reverse,
    becomes an ADR. It is *Accepted — not yet implemented* from the moment
    the feature leaves `feature:spec`, and flips to *Accepted* when the
    feature closes. A feature does not leave `feature:spec` while any ADR it
    links is still *Proposed*.

11. **The branch is named from the issue:** [coding.md](coding.md) rule 3.

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
    maintainer's account. `.agents/scripts/pr-body-check.mjs` checks a PR
    body's shape and budget: the issue-state workflow runs it on every PR,
    and the gate (rule 15) refuses a body it fails.

13. **Assume every agent is in a worktree:** [coding.md](coding.md) rule 4.

14. **A PR is marked ready only after review, and every blocking finding
    is answered.** The PR opens as a draft once the spec's tests are
    committed red, so CI runs from the first push and the PR body carries
    the work's status. It leaves draft only after the reviews below. Each
    reviewer is a fresh sub-agent defined in `.claude/agents/`, whose
    frontmatter pins the model and effort, reading a brief from
    `.agents/briefs/`. `.agents/scripts/review-inputs.sh` builds what each
    one reads; rules, ADRs and briefs come from `main`, so a PR cannot
    rewrite what it is judged by. No reviewer sees the PR body, the commit
    messages, the implementer or another reviewer's findings, and each reads
    first `.agents/briefs/calibration.md`, the findings rejected in the last
    four weeks, so a rejected class is not raised again without new
    evidence.
    - The *spec review* gets the issue body, its parent feature, the ADRs it
      names, the files under Rules in play, `always-in-scope.md`, a bug's
      triage report, the PR body's `Assumption:` lines, the diff, and every
      change made to the spec's tests since they were committed red. It
      answers: is every line of Scope and Done when delivered as written;
      does the diff do anything the spec did not ask for (what
      `always-in-scope.md` lists counts as asked for); does every test title
      state a claim the spec made; does any change after red leave a line of
      the spec unproven; is every assumption conservative and consistent
      with the spec. It reads; it runs nothing. An ADR diff is judged as a
      design record rather than against Completion conditions.
    - The *code review* gets the same specification, every file in this
      directory, the ADR index and the diff, in its own worktree. Behaviour
      lens: for each changed function, what input, state or interleaving
      makes it wrong, and what other code acting on the same state conflicts
      with it. Tests and rules lens: which test cannot fail for the reason
      its title gives, and which rule the diff breaks. One reviewer holds
      both lenses; a diff over 1,500 changed lines gets two, one per lens.
      It proves a claim with the affected test file only, may break code to
      see what stays green (testing rules 2 and 3), nine times at most, and
      may write one new test file to prove an interleaving, restoring the
      tree afterwards. It never runs the checks [toolchain.md](toolchain.md)
      leaves to the hooks and CI, nor the slow lane. A defect on a line the
      diff does not touch is a note; a conflict between the spec and a rule
      is a finding, never resolved silently.
    - The *claims review* gets the diff, this directory, and the output of
      `.agents/scripts/stale-refs.sh` (lines anywhere in the repo that still
      name what the diff removed); never the issue. It checks that every
      comment, doc line, test title, help text and error message the diff
      touches, the sweep finds, or the docs say about what the diff changed,
      is true of the code. Whether a comment may exist at all is the commit
      hook's (architecture rule 17), not a review's.
    The diff's kind (`.agents/scripts/diff-kind.mjs`) sets which of these
    run. An ADR-only diff gets the spec review alone; a docs-only or
    comments-only diff the spec and claims reviews; a tests-only diff all
    three, the code review with the tests lens only; any other diff all
    three. A PR that closes no issue gets no spec review.
    Each review lists what it checked and returns its findings, one per
    defect: a claim, its class (the general rule it breaks), the evidence as
    `file:line` or a command and its output, and *blocking* or *note*. A
    finding is blocking when it breaks behaviour, leaves wrong state, states
    something false, or breaches a rule, an accepted ADR or the spec;
    anything else is a note. A test for a case the spec does not name, or
    defensive code, is a note. A finding needs a concrete failure or a named
    cost and who pays it. A review returns at most five notes, each a
    possible wrong behaviour or state; nothing else is written down. Whether
    CI is green is never a finding: CI proves it, and the gate checks it
    (rule 15).
    A blocking finding is a claim, not a fact: it is verified against the
    code before anyone acts on it. A confirmed one is fixed, together with
    every other instance of its class; it is *src* when its fix must change
    production source, *text* when a test, a comment, a doc or an assumption
    line is enough. A rejected one is listed in the PR body under
    `## Review`, one line each, tagged `spec:`, `code:` or `claims:` with
    the reason, so the maintainer sees what was overruled. Accepted findings
    are not narrated.
    Rounds are at most two, plus one fix check. Round 1 reviews the whole
    diff. Round 2 runs only when round 1 confirmed a *src* finding: the code
    and claims reviews, on the fix alone, checking that each finding is
    resolved, that the fix adds no defect, and that no other instance of
    each fixed class is left; what they find outside that is a note, or an
    Out of scope line that becomes a `bug:new` issue when it is a confirmed
    defect. A *src* finding round 2 confirms gets one fix run and one *fix
    check*, the code and claims reviews on that fix alone; a commit pushed
    after the reviews passed (a merge of the base branch, a fix the gate
    needed) gets a fix check too, unless it changes only tests the PR's
    diff does not touch (a flaky test elsewhere): that one is listed under
    `## Review` as fixed unreviewed. A merge of a base branch that needed
    no conflict resolution brings in only commits reviewed in their own
    PRs, and gets no fix check either; CI checks it. A *src* finding a fix check confirms means
    the agent stops and hands off with it under Findings (rule 2), leaving
    the PR in draft. *Text* findings never stop delivery and get no further review:
    they are fixed in one run that edits tests, comments and docs only,
    listed under `## Review` as fixed unreviewed.
    Notes are not verified and never start a round: after the last check
    they go out once, as one comment on the PR. A note becomes an issue only
    when a person opens one. A PR from a person gets the same reviews when
    the maintainer asks for them.

15. **An agent merges only through the gate, and a feature merges as one
    stack.** `.agents/scripts/merge-pr.sh`
    is the one place a delivery PR is merged from; agents may not run
    `gh pr merge` themselves. A feature's PRs (its open ADR PRs, then each
    task's PR in the order its review passed) form one GitHub stack: each
    PR targets the branch of the one below, stays open once reviewed, and
    the stack merges once every task has joined it, so `main` never holds
    part of a feature. The gate then checks every PR in the stack and
    merges them together, all or nothing. A task depending on a reviewed
    task of the same feature starts on top of it: the issue-state workflow
    counts it as done. The script merges only a ready PR with no
    `needs-hardware` label, a body `pr-body-check.mjs` accepts (a `## Review`
    section with its counts line, no "spec needs" line, the agent footer),
    green CI, and no conflict. Before calling it the agent also checks what
    the script cannot read: no blocking finding is open. A conflict, or red
    CI, gets one fix run, a fix check (rule 14) and the gate again. Anything else short of that parks the issue with
    a handoff and leaves the PR for the maintainer.

16. **The slow lane runs one at a time, through its script.** The slow
    lane is the set of tests that need real hardware on a shared machine;
    two runs at once produce timeouts that look like bugs. Agents run it
    only through the script [toolchain.md](toolchain.md) names, which holds
    a machine-wide lock, runs detached so no tool time limit kills it
    halfway, and logs to a file. It runs once per PR, on the commit the last review round passed
    (no blocking finding open), so review fixes do not each cost a lane run.
    A failure gets one fix run, then the lane and the code review run again
    on the new commit. With a person present the agent asks once per
    delivery run, before the first lane, and that answer covers every PR in
    the run. Unattended, it runs when the lock is free; when
    the lock stays busy or the machine cannot run it, the PR gets
    `needs-hardware` and waits for the maintainer.

## Procedures

**Claiming work.** Find it, claim it, branch, and finish with a PR that
closes the issue:

```bash
gh issue list --search 'label:bug:ready,feature:ready,task:ready no:assignee'
gh issue view <n> --json body -q .body    # a task: every Depends on allows it (rule 1)
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
each stage to a background agent — `implementer`, `reviewer`,
`hardware-verifier` — that runs on the model its frontmatter pins and returns a fixed report.
`spec-session` and `triage-bug` cover the rest; `spec-session` ends its
technical and split modes with the `spec-checker` agent (rule 7).

## Automation

`.github/workflows/issue-state.yml` is the one place that enforces the label
rules mechanically, so nobody has to remember them:

- Adding a `<kind>:<state>` label removes any other one on the issue. Every
  transition is therefore a single add.
- A `task:ready` issue with no assignee goes back to `task:draft` when its
  Technical spec section is emptied. A claimed task is left alone.
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
`bug:triage` → `bug:ready`, and `feature:spec` → `feature:ready`. A task
needs none: the spec session sets `task:ready` once its check passes
(rule 1).
