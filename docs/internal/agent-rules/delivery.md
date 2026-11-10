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
| `bug:new`          | bug report form                     | An agent may triage it (rule 8), and nothing more.        |
| `bug:needs-info`   | triage agent                        | Could not reproduce. Waiting on the reporter.             |
| `bug:ready`        | maintainer, or the fast track (17)  | An agent may fix it.                                      |
| `bug:blocked`      | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |
| `feature:spec`     | spec session, on creation           | Spec in progress, business and technical together.        |
| `feature:planned`  | spec session, with its tasks ready  | Split into tasks. Never picked up itself.                 |
| `feature:blocked`  | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |
| `task:draft`       | spec session, on creation           | Scope written; technical spec or its spec check missing.  |
| `task:ready`       | spec session, after the spec check  | An agent may implement it once its Depends on allow.      |
| `task:blocked`     | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |
| `refactor:new`     | anyone, or the `refactor` routine   | A proposed refactor (rule 18). Nothing is built from it.  |
| `refactor:ready`   | maintainer, or the routine (18)     | An agent may build it.                                    |
| `refactor:blocked` | agent, on a blocked handoff         | Waiting on the maintainer to clear a blocker.             |

Four labels sit outside that scheme. `flaky-test` marks a bug that names a
test failing without a code change (testing rule 5). `needs-hardware` marks
a pull request parked because a Done when line needs a slow-lane run that
has not happened (rule 16). `fast-track` marks a bug the fast track set
ready, not the maintainer (rule 17). `auto-refactor` marks a refactor PR
the `refactor` routine started, not the maintainer (rule 18).

Transitions per kind:

- **request**: `new` until closed. Closed as not planned, or as completed with
  a comment naming the feature it became.
- **bug**: `new` → `ready` when the maintainer accepts the triage report
  or the fast track passes it (rule 17), with `needs-info` as a side-trip
  that returns to `new` when the reporter answers.
- **feature**: `spec` → `planned` when the spec session has set its tasks
  ready, then closed when its last sub-issue closes (rule 9).
- **task**: `draft` → `ready` when its spec check passes, and back to
  `draft` if the technical spec is emptied or the maintainer moves it.
- **refactor**: `new` → `ready` when the maintainer sets it, or the
  `refactor` routine does on an issue it opened (rule 18).
- **any kind**: `ready` → `blocked` (for a bug under triage, `new` →
  `blocked`) when an agent stops on a blocker it names in its handoff. The
  maintainer clears it by re-adding the label it came from.

Everything after `ready` is read from GitHub itself, not from a label:
in progress means an assignee is set, in review means a linked pull request
is open, done means closed as completed.

## Rules

1. **An agent acts only on `bug:new` (triage only), `bug:ready`,
   `task:ready` and `refactor:ready`.** Nothing else is work. The work on `bug:new` is the
   triage report (rule 8); the maintainer moves a bug to `bug:ready`
   after reading it, or the fast-track script does (rule 17). Agents
   never label their way into work: only a
   maintainer, automation a maintainer configured, or the spec session
   that wrote a task and saw its spec check pass (rule 7) moves an issue
   to a state an agent may act on. The one exception is the `refactor`
   routine, which may set `refactor:ready` on an issue it opened when rule
   18's three conditions hold. The maintainer's say on a task is
   the spec session, which they sit through; they can move a task back to
   `task:draft` at any time. A `task:ready` task runs once every issue
   under its Depends on is closed, or is a task of the same feature whose
   PR passed review. Delivering a `feature:planned` feature means
   delivering its `task:ready` tasks in their Depends on order.

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
   for. Before its first question, it maps what exists today (the code, the
   docs and ADRs, open work in the same area, other tools) with direct searches
   or bounded read-only explorers under `docs/internal/EXPLORATION.md`. It
   checks the evidence and puts unresolved requirement contradictions and
   work conflicts to the maintainer first; intended changes are not conflicts. It ends by editing the body and leaving one short
   comment saying which sections moved, so a reader of the thread can see
   where the spec last caught up.

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
   Implementation lives in an ADR and in the feature's design tables
   (Behaviours, Stored state, Interfaces, Existing code), each fact once.
   The same spec session writes the business sections, the design and the
   tasks.

7. **The design is checked before a task is written, and a task names
   its rows.** A task's Scope is the slice of the parent's outcome it
   delivers; its Technical spec names the parent's design rows it
   delivers and adds what a delivery agent needs to build them without
   asking: the facts no row holds, modules touched, which rules in this
   directory are in play, and one test per Behaviours row. A task never
   restates a row. A fact is what existing code,
   another tool or the machine does today; each cites the line or the
   command output it was read from, never a summary. It need not repeat
   what `always-in-scope.md` lists, and a small gap it leaves is an
   assumption, not a question (rule 3). A task with an empty technical
   section is `task:draft` no matter what anyone says in a comment. The
   lint runs before the check: `.agents/scripts/spec-lint.mjs` checks the
   body's structure, the spec session fixes its blocking lines before any
   checker starts, and the issue-state workflow moves a task whose lint
   fails back to `task:draft`. Fresh `spec-checker` agents read the
   feature's design against the code before any task exists, and the
   tasks against the design before they get `task:ready`; the spec
   session fixes what they report, and the same checker rechecks only
   what the fix changed. The maintainer approves the feature, its design
   and its ADRs once, before the tasks are written; a later finding that
   needs a decision goes back to them.

8. **Triage produces a report, not a fix.** An agent triaging a `bug:new`
   issue reproduces the bug as a failing test whose title states the claim
   the test proves, finds the root cause, and posts one comment with exactly
   these sections: *Reproduction*, *Root cause* (with file and line),
   *Simplest fix*, *Alternatives rejected* (at most three, one line each),
   *Risk* (at most three bullets), *Fast track* (rule 17's five lines), and
   *Side findings* when there are any. The root cause says first whether this is a defect
   (the code does the wrong thing) or a gap (nothing is wrong and something
   is missing); for a gap the test's expectation is a proposal
   and the report says so; `bug:ready` on a gap accepts that proposal. A
   separate problem found on the way is opened as
   its own `bug:new` issue and listed under Side findings, not described in
   the report. It pushes the failing test to a
   `bug/<number>-repro` branch and opens no pull request. It then unassigns
   itself and leaves the label at `bug:new`; it never runs the fast-track
   script on its own report. If it cannot reproduce, it
   moves the issue to `bug:needs-info`, says exactly what is missing, and
   unassigns itself.

9. **Done is defined per kind.** A task or bug is done when the pull request
   that closes it is merged; for a bug the failing test from triage is the
   regression test and must be in that PR. A `feature:planned` issue is
   done when every sub-issue is closed and the PR that closed the last one
   walks every completion condition. The
   delivering agent merges its own PR, but only through the gate in rule
   15.
   Verification is part of delivery, not a step after it ([coding.md](coding.md)
   rule 5). The issue-state workflow closes the feature as completed when
   its last sub-issue closes; the maintainer may reopen it.

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
    and the gate (rule 15) refuses a body it fails. The tool guard refuses,
    before it is posted, a body or comment without the footer, and a
    handoff, triage report, "Spec updated" or review notes comment out of
    its shape or budget.

13. **Assume every agent is in a worktree:** [coding.md](coding.md) rule 4.

14. **Review before ready.** Every PR starts in draft and leaves it only
    after [the review protocol](../REVIEW.md): independent spec, code and
    claims lenses on a pinned commit, rules and briefs from the PR base, and
    at most one full round, one targeted round 2 and one fix-check. A PR
    with an open blocking finding or an incomplete assessment at the cap
    stays in draft for the maintainer.

15. **An agent merges only through the gate, and a feature merges as one
    stack.** `.agents/scripts/merge-pr.sh`
    is the one place a delivery PR is merged from; agents may not run
    `gh pr merge` themselves. A feature's PRs (its open ADR PRs, then each
    task's PR in the order its review passed) form one GitHub stack: each
    PR targets the branch of the one below, is linked into the stack as
    soon as its draft PR exists, stays open once reviewed, and the stack
    merges once every task has joined it, so `main` never holds part of a
    feature. A stack moves by merging forward, bottom to top, through
    `.agents/scripts/stack-sync.sh`, never by rebasing: a merge is a
    fast-forward push, a rebase a force push nobody may make. The ADR
    branch is merged up to `main` and its PR reviewed before the first
    task builds. The gate then checks every PR in the stack and
    merges them together, all or nothing. A task depending on a reviewed
    task of the same feature starts on top of it: the issue-state workflow
    counts it as done. The script merges only a ready PR with no
    `needs-hardware` label, a body `pr-body-check.mjs` accepts (a `## Review`
    section with its counts line, no "spec needs" line, the agent footer),
    green CI, and no conflict. Before calling it the agent also checks what
    the script cannot read: no blocking finding is open and assessment is complete. A conflict, or red
    CI, gets one fix run, a fix check (rule 14) and the gate again. Anything else short of that parks the issue with
    a handoff and leaves the PR for the maintainer.

16. **The slow lane runs one at a time, through its script.** The slow
    lane is the set of tests that need real hardware on a shared machine;
    two runs at once produce timeouts that look like bugs. Agents run it
    only through the script [toolchain.md](toolchain.md) names, which holds
    a machine-wide lock, runs detached so no tool time limit kills it
    halfway, and logs to a file. It runs once per PR, on the commit the
    last review round passed (no blocking finding open), so review fixes do
    not each cost a lane run. A failure starts a loop: a fix run that may
    rerun the failing tests on the lane, then the whole lane again, until it
    passes or six lane runs have failed. The loop's fixes are commits on the
    PR's branch, even for code an earlier PR of the stack added, with no
    review and no new PR in between; once the lane passes, one fix check
    reviews every commit the loop added. The lane needs nobody's leave: it
    runs when the lock is free, unless the delivery run was started with
    `no-hardware`. When the lock stays busy, the machine cannot run it, or
    the loop gives up, the PR gets `needs-hardware` and waits for the
    maintainer.

17. **An easy bug goes from its report to `main` without waiting for the
    maintainer.** Two checks by `.agents/scripts/fast-track.mjs` decide
    "easy". Both read facts; neither asks an agent how sure it is.
    *Entry.* The triage report ends with a Fast track section of five
    lines, each `yes` or `no — <why>`:
    - **Defect**: the code does the wrong thing; not a gap, not a decision.
    - **Fix tried**: the Simplest fix, applied in the working tree, made
      the reproduction pass and kept the tests next to it green, and was
      then discarded.
    - **Nothing public added or broken**: no command, flag, config key,
      route, tool, event, error code or wire field is added or removed, and
      nothing a caller does today stops working.
    - **No ADR or rule changed**: the fix follows every accepted ADR and
      rule as written.
    - **One fix**: no rejected alternative would change what a user sees,
      and no other repository could carry the fix.

    Five times `yes` in a report posted from an account that can write to
    the repo, a `bug/<n>-repro` branch, and no person's comment after the
    report: the script sets `bug:ready` and `fast-track`. One
    `no`: the bug stays `bug:new` and waits for the maintainer, as any bug
    did before. *Exit.* The gate (rule 15) runs the script on the fix's PR
    and refuses one that changes more than 250 lines or 8 files, touches
    a surface file `docs-surface-check.mjs` lists (the command tree, the
    config, the error table, the MCP tools, an HTTP source, the client
    exports, the event map), the protocol version or an ADR, or carries a
    `## Decision taken` comment. A fix elsewhere, a console screen or a
    command's output included, is not held for its path.
    An `Assumption:` line is a minor decision and passes. A held PR stays
    open and ready: the maintainer merges it, or removes `fast-track` and
    lets the gate through. The orchestrator runs the script, never the
    agent that wrote the report or the fix, and no sub-agent removes
    `fast-track` (the tool guard refuses both).

18. **A refactor changes structure, never behaviour, and needs no spec.**
    *Kind.* A refactor issue is `refactor:new`, `refactor:ready` or
    `refactor:blocked`. Its branch is `refactor/<n>`. Its PR title reads
    `refactor(<module>): …`, and so do the commits that refactor, each
    ending `(#<n>)`; the pin commit and the commit that deletes the pins
    read `test(pin): … (#<n>)`. A change that cannot keep every line of
    this rule is a task, not a refactor.

    *Body.* `docs/internal/templates/refactor.md`: **Why** (one or two
    sentences), **Target shape** (what moves where, or what replaces
    what), **Out of bounds** (the modules and files it must not touch),
    **Done when** (structural checks, such as "no file in `src/daemon/`
    over 1,400 lines", never a behaviour). No Facts, no Technical spec, no
    spec check; `spec-lint.mjs` checks only those four sections.

    *Behaviour* is everything testing rule 3 counts as visible: results,
    error codes and messages, printed text, events, stored records, wire
    shapes, the calls to other tools and their order, and time limits.
    The exports of every module's `index.ts`, every surface file
    `docs-surface-check.mjs` lists, the protocol version and every ADR
    stay as they are. Today's behaviour is kept even when it is wrong.

    *Who sets `refactor:ready`.* The maintainer, on any refactor issue.
    The `refactor` routine, on an issue it opened, when all three hold:
    1. the target is a measurement: a file over a cut-off an accepted ADR
       sets, or a Fallow refactoring or duplication finding; the issue
       quotes the command and the output line;
    2. no open PR, claimed issue or `task:ready` task's Modules touched
       names a file of the target;
    3. the Target shape follows from an accepted ADR or from the
       measurement, so it takes no new decision.

    The routine opens one issue per run, for one module, and its PR
    carries `auto-refactor`. It reads the cut-offs, the Fallow config and
    the ADRs and never edits them: a threshold is the maintainer's call.

    *Pins.* Where the existing tests do not reach the code it moves, the
    implementer adds pins: tests in `*.pin.test.ts` files that record what
    the code does today, golden-master tables included. A pin drives the
    nearest seam the refactor does not move, so the refactor cannot break
    the pin itself. Pins are the branch's first commit, `test(pin): …`,
    with nothing else in it, and pass on the base; there they replace
    tests-first, and a pin that fails on the base is a bug or a
    misunderstanding, never something to fix. `pnpm mutate --touched-by
    <head>`, run on that commit, mutates the source lines the refactor
    moves or changes; every mutant must die against the pins and the
    existing tests. Only testing rule 2 binds a pin, and test-lint skips
    them. The PR's last commit deletes every pin, unless the code review
    promotes one that covers a real gap: it then meets all of testing.md
    and moves into the module's test file.

    *Evidence.* `.agents/scripts/refactor-check.mjs --pr <m>` runs in
    the gate (rule 15), which refuses a refactor PR it fails:
    1. **Tests unchanged.** Every test title at the merge base is still
       at the head, pins aside, whichever file holds it; a title only the
       head has (a promoted pin) is listed for the code review. A line a
       test file adds or removes that did not move (no other line of the
       diff reads the same) fails when it asserts (`expect(`, `assert`);
       every other such line is listed for the code review.
    2. **Surface unchanged.** Every module `index.ts` exports the same
       names with the same types at both ends, and no surface file, ADR
       or protocol version changed.
    3. **Pins passed, and are gone.** The first commit's pins pass on the
       current merge base and on the head with the pins put back; no later
       commit adds or edits a pin, and none is left at the head. A base
       branch merged in moves the merge base, so its changes are never
       read as the refactor's.
    4. **Survivors killed.** The mutation run of *Pins*, repeated on that
       merge base with the pins, leaves no mutant alive.

    The PR body carries `Tests: <n> before, <n> after.` and `Mutation:`
    with the run's last line.

    *Stops.* A refactor that needs to change behaviour, an existing
    test's expected value or the surface stops with a handoff saying
    `spec needs: a task for <what>`. A bug found on the way is opened as
    `bug:new` and pinned as it is, not fixed. A mutant no pin can kill
    without reaching an internal file stops with `spec needs: a task; no
    seam pins <lines>`. "While I'm here" is a stop.

    *Review.* No spec lens. The code lens reads the refactor section of
    its brief, which lists the hidden behaviour changes; the claims lens
    covers manuals, comments and test titles. A refactor PR that passes
    `refactor-check.mjs`, its review and CI merges through the gate
    without the maintainer, whatever its size.

## Procedures

**Claiming work.** Find it, claim it, branch, and finish with a PR that
closes the issue:

```bash
gh issue list --search 'label:bug:ready,task:ready,refactor:ready no:assignee'
node .agents/scripts/claim.mjs <n>    # refuses a closed, claimed or not-ready issue, or a task its Depends on hold back
.agents/scripts/worktree.sh task/<n>    # or bug/<n>, refactor/<n>, feature/<n>; resumes origin/<branch>
```

The PR body contains `Closes #<n>`. For a bug, branch from `bug/<n>-repro`
when it exists so the triage test is carried forward.

**Finding triage work.** A `bug:new` issue with no assignee and no triage
report on its thread:

```bash
gh issue list --label bug:new --search 'no:assignee' --json number,title,comments \
  --jq '[.[] | select(all(.comments[]; .body | test("^## Root cause"; "m") | not))]'
```

**Moving a label.** Add the new one and remove the old one in the same
command, so the one-label invariant never breaks in between:

```bash
gh issue edit <n> --add-label bug:needs-info --remove-label bug:new
```

The repo's own skills encode these procedures; use them rather than
retyping the steps. `deliver` is the orchestrator: it claims, then hands
each stage to a background agent — `implementer`, `reviewer`,
`hardware-verifier` — that runs on the model its frontmatter pins and returns a fixed report.
`spec-session` and `triage-bug` cover the rest; `spec-session` starts with
selective exploration (rule 4) and has the `spec-checker` agent check the
design, then the tasks (rule 7).

## Automation

`.github/workflows/issue-state.yml` is the one place that enforces the label
rules mechanically, so nobody has to remember them:

- Adding a `<kind>:<state>` label removes any other one on the issue. Every
  transition is therefore a single add.
- A `task:ready` issue with no assignee goes back to `task:draft` when its
  Technical spec section is emptied. A claimed task is left alone.
- A comment by the reporter on a `bug:needs-info` issue moves it back to
  `bug:new`, reopening the issue if it had been closed. Two weeks of
  silence closes it as not planned.
- When the last sub-issue of a `feature:planned` issue closes, the workflow
  closes the feature as completed, with a comment.
- A feature closed as completed, by that job or by a person, closes the
  `request:new` issue it names on its `Request:` line, with a comment
  pointing at the feature.
- A pull request closed without merging releases the claim on every issue
  its body closes, with a comment. The label is left as it was.
- A claim on a `*:ready` issue with no comment, label change, or commit on
  `<kind>/<n>` for three days is released, with a comment.
- A pull request from a `<kind>/<n>` branch fails its check unless its body
  closes `#<n>` and closes nothing else. A branch that starts with a kind
  prefix and is not exactly `<kind>/<n>` (or an ADR's `feature/<n>-adr...`)
  fails it, and so does a PR that closes a task or a bug from any branch
  but that issue's `<kind>/<n>`.

`bug:new` → `bug:ready` is the maintainer's call once they have read the
triage report, except for a bug the fast track passes (rule 17). A task
needs none: the spec session the maintainer sits through sets
`task:ready` once its check passes (rule 1).
