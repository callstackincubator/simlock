# How work flows

The maintainer's guide to how work moves from an issue to `main`: what you
do, what agents do, and where each step is defined. The binding rules are
in [agent-rules/delivery.md](agent-rules/delivery.md); each skill and agent
holds its own steps. This page links to them rather than restating them.

## The model

GitHub Issues is the spec and the queue. Every issue carries exactly one
`<kind>:<state>` label, and agents act only on `bug:triage`, `bug:ready`
and `task:ready`. The body is the spec; a comment changes nothing until a
spec session folds it in. A reporter's issue is never rewritten. After
`ready`, state is read from GitHub itself (assignee, linked PR, closed).
Issue `<n>` is built on branch `<kind>/<n>`.

| Label             | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `request:new`     | Inbox. Never picked up, body never edited.               |
| `bug:new`         | Reported. Nobody has looked yet.                         |
| `bug:triage`      | An agent may reproduce it and write the triage report.   |
| `bug:needs-info`  | Could not reproduce. Waiting on the reporter.            |
| `bug:ready`       | An agent may fix it.                                     |
| `bug:blocked`     | Waiting on the maintainer to clear a blocker.            |
| `feature:spec`    | Spec in progress, business and technical together.      |
| `feature:planned` | Split into tasks. Never picked up itself.                |
| `feature:blocked` | Waiting on the maintainer to clear a blocker.            |
| `task:draft`      | Scope written; technical spec or its spec check missing. |
| `task:ready`      | Spec checked; runs once its Depends on allow.            |
| `task:blocked`    | Waiting on the maintainer to clear a blocker.            |

## A bug

1. A bug arrives as `bug:new`. If it sounds real, add `bug:triage`.
2. `triage-bug` reproduces it as a failing test on `bug/<n>-repro` and
   posts one report comment (delivery rule 8). If it cannot reproduce, it
   moves the issue to `bug:needs-info`.
3. You read the report. Agree: add `bug:ready`, which also accepts the
   shape the report proposes for a gap. Disagree: reply and re-add
   `bug:triage`.
4. `deliver` builds the fix on `bug/<n>` from the repro branch, reviews it
   and merges it. The triage test becomes the regression test.

## A feature

1. Create a `feature:spec` issue, or take up a `request:new` one: the spec
   session creates the feature from it and links the two. The request
   closes when the feature ships.
2. Run `spec-session` and sit through it. It explores first, then asks
   you every decision in rounds, each with a recommended answer and an
   `Explain` option. It never asks you a fact: background explorers read
   the source for each one. Decisions that bind more than one task become
   ADRs.
3. It posts the feature and its tasks as `task:draft`, has `spec-checker`
   agents check them, and fixes what they find. It asks you only about
   findings that need a decision.
4. You approve once, from a short summary: the feature, each ADR, a table
   of the tasks with their Depends on. The tasks become `task:ready` and
   the feature `feature:planned`. Move a task back to `task:draft` to hold
   it.
5. Run `deliver <feature>`. It delivers the tasks in dependency order, two
   at a time, and merges the feature's PRs as one stack at the end.

A session can stop part way: what is settled is written, the rest goes
under Open questions, and the next session starts there.

## What `deliver` does, and when it stops

`deliver` writes no code. It hands each stage to a background agent in
`.claude/agents/` (`implementer`, `reviewer`, `hardware-verifier`) and
reasons only over the report each returns. The implementer works
one test at a time, each committed failing before the code that passes
it, one fresh agent per mode (build, audit), and runs only
the tests its change reaches; hooks and CI run every other check
([toolchain.md](agent-rules/toolchain.md)).

What you will see:

- **`Assumption:` lines** in the PR body: small gaps the implementer closed
  the conservative way. Reject one by replying.
- **`## Decision taken` comments**: a choice a user would notice that
  nobody made. The run takes the conservative option, notes it in the
  issue body as pending you, and says how to reverse it. It does not stop
  to ask.
- **A parked issue with a `## Handoff` comment**: the run stops only for a
  contradiction with a rule or an accepted ADR, a blocking review finding
  still open after the last round, a slow-lane check that could not run,
  or a gate refusal. A handoff that names a blocker moves the issue to
  `<kind>:blocked`.
- **One `## Delivery run` comment** at the end: merged, parked, waiting,
  decided.

What any change includes without its spec asking is listed once, in
[always-in-scope.md](agent-rules/always-in-scope.md).

## Review, hardware and merge

- **Review.** Every PR leaves draft only after the independent spec, code
  and claims reviews in [REVIEW.md](REVIEW.md). Notes go out as one
  comment after the last round.
- **Hardware.** A Done when line that needs a real device runs through
  `verify-hardware` and the slow lane, one lane per machine (delivery rule
  16). A PR whose lane could not run gets `needs-hardware` and waits for
  you.
- **Merge.** Agents merge only through `.agents/scripts/merge-pr.sh`
  (delivery rule 15). A feature's PRs form one GitHub stack, its ADR PRs at
  the bottom, and merge together, so `main` never holds half a feature.
  The stack is kept current by `.agents/scripts/stack-sync.sh`, which
  merges forward bottom to top and never rebases, so no human has to
  force-push. A bug merges on its own.
- The same reviews run on a person's PR when you ask; the agent posts the
  findings as a comment and pushes nothing.

## Automated and manual

`.github/workflows/issue-state.yml` makes the mechanical transitions:

- adding a state label removes the previous one;
- an emptied Technical spec sends a `task:ready` task back to `task:draft`;
- a reporter's reply moves `bug:needs-info` back to `bug:triage`, and two
  silent weeks close it;
- a closed last sub-issue asks you to close its feature, and a closed
  feature closes its request;
- a closed PR, or a claim silent for three days, releases the claim;
- a PR from `<kind>/<n>` must close `#<n>` and nothing else.

Two transitions stay manual on purpose, one click each: `bug:new` →
`bug:triage` and `bug:triage` → `bug:ready`.

## Watching the pipeline

`node .agents/scripts/delivery-stats.mjs` prints one row per week for the
last five: blocking findings per review raised and fixed, notes, PRs
needing a second round, median hours to merge, rounds and tokens,
handoffs. `--since <date>` lists PRs; `--calibration` prints the recent
incorrect findings every reviewer reads. `delivery-counters.mjs --since
<date>` prints the per-PR counters the process review judges delivery
changes by (CI lines sent to fix runs, stack syncs, empty builds, fix runs
that changed nothing, tests per Tests line), and `instruction-reads.mjs`
how often each role opens each rule, brief and manual. Change one thing in
the pipeline at a time and compare the rows before and after.

Weekly routines keep the suite and the reviews in shape: `harden-tests`,
`audit-tests`, `garden-comments` and `calibrate-reviews`
([toolchain.md](agent-rules/toolchain.md) "Routines").

## `main` and releases

`main` takes changes only through a PR whose Quality, Fallow and Console
checks passed. It is a GitHub ruleset that binds agents and you alike.
Releases run from the Release workflow (`.github/workflows/release.yml`),
started by hand on `main`; agents cannot start it (`gh workflow run` is
denied in `.claude/settings.json`).

## Where ADRs fit

A feature answers _what_ and _why_; a task answers _how_ for one PR; an ADR
answers _how_ only for a choice that binds more than one task or is
expensive to reverse. Its status follows the feature (delivery rule 10).
See [adr/README.md](adr/README.md).

## Moving the agent kit to another project

The agents, skills, briefs, scripts, `delivery.md`, `testing.md`, the
templates and the issue-state workflow and labels hold no fact about this
project. To move them, copy those, then write the new project's
`toolchain.md`, `always-in-scope.md` and its own rules, rewrite
`worktree.sh` and `ensure-pnpm.sh` for its package manager, and change
`tool-guard.mjs`'s list of checks.

## Where things live

| What                      | Where                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| Rules                     | [agent-rules/](agent-rules/)                                             |
| Spec templates            | [templates/](templates/)                                                 |
| Skills (what you run)     | `.claude/skills/`                                                        |
| Agents (stages, reviewers) | `.claude/agents/`                                                        |
| Stage and review briefs   | `.agents/briefs/`                                                        |
| Scripts and hooks         | `.agents/scripts/` (hooks wired in `.claude/settings.json`), `scripts/` |
| Labels and reporter forms | `.github/labels.json`, `.github/ISSUE_TEMPLATE/`                         |
| Issue automation          | `.github/workflows/issue-state.yml`                                      |
| Releases                  | `.github/workflows/release.yml`                                          |
