# How work flows

GitHub Issues is the specification and the queue. An issue's body is what an
agent builds against; its label is the only thing that tells an agent whether
it may act. This page is the maintainer's manual for that model. The binding
rules are in [agent-rules/delivery.md](agent-rules/delivery.md); this page
explains how they fit together in practice.

## The model in five sentences

Every issue carries exactly one `<kind>:<state>` label, and the prefix is the
kind. Agents act only on `bug:triage`, `bug:ready` and `task:ready`;
everything else is either an unread claim from outside or an
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
| `feature:spec`    | Spec in progress, business and technical together.      |
| `feature:planned` | Split into tasks. Never picked up itself.                |
| `feature:blocked` | Waiting on the maintainer to clear a blocker.            |
| `task:draft`      | Scope written; technical spec or its spec check missing. |
| `task:ready`      | Spec checked; runs once its Depends on allow.            |
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
6. An agent running `deliver` claims the `bug:ready` issue and has the
   `implement` skill build it on `bug/<n>`, starting from the repro branch.
   The change is reviewed and merged through the gate (below). The triage
   test is now the regression test. Merge closes the bug.

## A feature, from request to tasks

One spec session takes a feature from the request to ready tasks. You sit
through it. It maps the code, docs and open work before its first
question, so a conflict with today's code comes up while the design can
still change.

1. The maintainer creates a `feature:spec` issue, or an outside request
   arrives as `request:new` and the maintainer decides to take it up. Nothing
   happens to a request by default. The session can start from either: from
   a request it creates the feature issue, links it to the request, and
   comments on the request so the reporter knows where to look. The request
   stays open until the feature ships.
2. **Reconcile.** The session lists every comment posted since the body was
   last edited, on both threads, as proposed changes; you accept or reject
   each.
3. **Explore.** Map relevant code, docs/ADRs and open work using direct
   searches or bounded read-only Haiku helpers when they save context.
   [The exploration contract](EXPLORATION.md) requires the commit, searched
   scope, supporting excerpts, uncertainty and omissions. The session reads
   surrounding source before relying on facts, reuses verified maps and
   revalidates changed entries. Intended changes are not contradictions.
4. **Interview.** The session opens with today's flow as a diagram, the
   contradictions and conflicts it kept, and its one-line read of what you
   want, with a confidence. Then it asks in rounds: each round is every
   decision whose prerequisites are settled, business and technical alike,
   each with its recommended answer first and an `Explain` option: pick it
   and the session shows the problem and what each option brings, with
   diagrams or snippets, then asks again. It looks up facts itself and
   never asks you one: while you answer, background explorers read the
   source behind each claim about today, another tool's included. Any
   decision that constrains more than one task or would be expensive to
   reverse becomes an ADR at _Proposed_. It ends when no decision is left
   open.
5. **Facts.** Every claim the design rests on has a source line before
   anything is written. One with none is a question for you.
6. **Write.** The feature gets its business sections from
   [templates/feature.md](templates/feature.md), Decisions, Shared values
   and Tasks. Each task is a native sub-issue, labelled `task:draft`, with
   a body from [templates/task.md](templates/task.md): Scope, Technical
   spec, Facts, Done when, Out of scope and Depends on. A small feature is
   one task. Every fact cites the line or command output it was read from.
   The bodies are posted as drafts without asking you.
7. **Check.** `check-spec` reads the bodies as posted, one checker per task
   and one for the feature as a whole. It first plans the change file by
   file and runs a pre-mortem, then gives every category a status:
   contradictions, lines nobody could check, behaviour no test pins,
   failure modes no line answers, existing code on the same state no line
   names, lists the code contradicts, overlapping tasks without a Depends
   on, and undefined terms. Each finding is blocking (an implementer
   would build the wrong thing, stop, or leave broken state) or a note (a
   gap the implementer may close as an `Assumption:` line, five at most).
   The session fixes the blocking ones, asking you in one round about any
   that needs a decision; notes never start another round. Then the same
   checker rechecks only what the fix changed; a finding still open goes
   to you.
8. **Approve, then ready.** You approve once, from a short summary: the
   feature, each ADR in a line or two, and a table of the tasks with their
   Depends on and any open findings. The session then sets every task
   `task:ready` and the feature `feature:planned`, and the ADRs move to
   _Accepted — not yet implemented_. Your say is the
   session; move a task back to `task:draft` to hold it. Depends on sets
   only the order: `deliver` starts a task once each dependency is closed
   or is a task of the same feature whose PR passed review.

A session can stop part way. It writes what is settled and lists the rest
under Open questions; the feature stays `feature:spec`, and the next session
starts there.

Then `/deliver <feature>` delivers the tasks in dependency order, two at a
time, merging the feature's PRs together at the end. A small gap a task
leaves open it closes the conservative way and lists as an `Assumption:`
line in the PR, for you to see. It stops and hands back to you only for a
contradiction with a rule or an accepted ADR, a blocking review finding it
could not settle, or a real-device check it could not run. It ends with one
comment on the feature listing what merged, what parked and why, and what
is still waiting.

Each task is one PR, on `task/<n>`, reviewed before it leaves draft
(below). Verification is part of delivery. Every task PR walks its Done
when, and the PR that closes the last open sub-issue also walks the
feature's Completion conditions. When that last sub-issue closes, the
automation comments on the feature, and the maintainer closes it. If the
feature came from a request, the request closes on its own with a pointer
to the feature.

## Review, verification and merge

`deliver` never writes code itself. It hands each stage to a new background
agent in `.claude/agents/` that runs on the model and effort its
frontmatter pins — `implementer`, `reviewer` and `bug-triager` on Sonnet,
`spec-checker` on Opus — up to two issues at once, and reasons only over the
fixed report each one returns. The stage skills of the same names are thin
wrappers that start those agents when a person invokes them, after renaming the session
so its title names the issue or PR. `deliver` and `spec-session` run in
the session that invoked them; their frontmatter pins Opus only until the
next message, so an unattended run keeps it and an attended one returns to
the session's model after the first reply. `implement` runs as a fresh
agent per phase, so no context grows past one phase: one commits the spec's
tests red and opens a draft PR, so CI runs from the first push; the next
turns them green in commits that each lower the failing count, starting
from a map of which files each test needs; the last audits the diff with
fresh eyes. Agents pass each other `key: value` lines, not prose; each
stage agent's steps are a brief in `.agents/briefs/`, read on demand, so
the agent's own instructions stay short. It
runs only the tests its change can reach — `pnpm test:changed` and the e2e
files it touched. Every other check runs on its own: format, lint and
typecheck on commit; Fallow and the e2e typecheck on push; the full suite
in CI. Mutation testing is not part of delivery: it ran on every push and
held each push for minutes, and the tests it added in its last weeks were
mostly details no caller depends on. The weekly `harden-tests` routine runs
it on what `main` changed most recently, and kills only the survivors a
caller or user could see. The weekly `audit-tests` routine reads the
tests `main` changed for duplicates, log-only tests, data-only cases and
assertions that cannot fail (testing rules 7 to 10): a cheap model scans,
a stronger one verifies each finding, and only the confirmed ones are
applied. Each push cancels the CI
run before it, so before every review round and fix run the orchestrator
reads the newest finished run with `.agents/scripts/ci-failures.mjs`, and
its failed tests go into the next fix run.

A spec never answers every question. What any change includes without
asking — docs it makes false, both `EVENTS.md` files, a test for every new
path, Fallow entries — is listed once, in
[agent-rules/always-in-scope.md](agent-rules/always-in-scope.md). When the
body, the rules and the ADRs all leave a smaller gap open, `implement`
closes it the conservative way and records it as an `Assumption:` line in
the PR body. An assumption is a proposal you can see and reject, not a
change to the spec.
The run parks only for a contradiction with a rule or an accepted ADR. A
choice a user would notice that nobody made does not stop it: the
orchestrator takes the conservative option, writes it into the issue body
as pending the maintainer, merges, and posts a `## Decision taken` comment
on the PR saying how to reverse it. A question left to a person used to stop
the run until they answered: five hours one night in #466, though the
maintainer picked the recommended option 15 times of 16.

A PR leaves draft after complete assessment, with no blocking finding open.
[The review protocol](REVIEW.md) defines the procedure: immutable actual-PR
bases, independent lenses selected by semantic risk, deduplication before
verification, and a resolution ledger carried across targeted follow-ups.
Spec uses Sonnet for ordinary acceptance checks and Opus for consequential
decisions. Code remains Opus by default; routine Sonnet is an explicit pilot.
Claims and coordination use Sonnet. Haiku is not a semantic reviewer.

One full round is followed by at most a targeted round 2 and final fix-check.
Actual impact selects rechecks: test assertions are logic, changed acceptance
needs spec review, and claims run only where affected. Budget exhaustion
means incomplete. Late PR regressions still block at the cap; pre-existing
unrelated debt is separate. Counts include every invocation, even fix-check,
and unknown usage or cost remains unknown. The protocol specifies the clean
and buggy replay corpus, live shadow evaluation and rollback before any
routine-model downgrade can become default.

A Done when line that needs a real simulator or emulator runs through the
`verify-hardware` skill and `scripts/slow-e2e.sh`, one lane per machine, on
the commit the last review round passed. A hardware failure gets one fix
run, then the code review and the lane run again. A PR whose hardware check
could not run gets `needs-hardware` and waits for you. Everything else that
passes is merged by the agent through `.agents/scripts/merge-pr.sh`, which
refuses a draft, a `needs-hardware` label, a body
`.agents/scripts/pr-body-check.mjs` fails (no Review section with its counts
line, a "spec needs" line, no agent footer), red CI, or a conflict. Red CI gets one automatic re-run
first when no failure is the PR's own: a job GitHub cancelled because no
runner came, or a failing test an open `flaky-test` issue names. The same reviews run on a
person's PR when the maintainer asks; there the agent posts the findings as
a comment and pushes nothing.

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
`.agents/scripts/pr-body-check.mjs` checks a PR body's shape and budget; the
issue-state workflow runs it on every PR, as warnings while it is a draft
and a failed check once it is ready.

## What is automated and what is not

The workflow in `.github/workflows/issue-state.yml` handles the transitions
that are mechanical: adding a state label removes the previous one, so every
transition is a single add; a `task:ready` task whose Technical spec is
emptied goes back to `task:draft`; a
reporter's reply moves `bug:needs-info` back to `bug:triage` and reopens the
issue if needed; a silent `bug:needs-info` closes after two weeks; a feature
whose last sub-issue closed gets a note to close it; a completed feature
closes its request; a PR closed without merging or a claim silent for three
days releases the claim; a PR from a `<kind>/<n>` branch must close `#<n>`
and nothing else. The repo's skills — `spec-session`, `triage-bug`,
`deliver`, `review` — handle the transitions an agent makes as part of its
own procedure, and the reviews are the delivering agent's job, not CI's.

Two transitions are judgments and stay manual on purpose: `bug:new` to
`bug:triage`, and `bug:triage` to `bug:ready`. Each is one click. Tasks
need no click: the spec session you sit through marks them ready once
their check passes.

## Watching the pipeline

`node .agents/scripts/delivery-stats.mjs` turns the PRs merged in the last
five weeks into one row per week: for each review, how many blocking
findings it raised and how many were confirmed and fixed; the notes raised;
how many PRs needed no fix, or a second round; the median hours from
opening to merge, review rounds and session tokens (the `Rounds: <n>.
Tokens: <n>M.` line each PR body carries; `.agents/scripts/usage.mjs` reads
the tokens from the session's transcripts); handoffs. PRs from before the
blocking/note split count every finding they raised. Below the table it
lists one row per PR merged this week (`--since <date>` widens it) with its
hours, size, rounds and tokens, then this week's rejected findings,
handoffs and PRs waiting on hardware. Change one thing in the pipeline at a
time and compare the rows before and after. A review whose blocking
findings are mostly rejected costs a verification each and changes nothing:
tune its brief, or what `always-in-scope.md` lists. A rejection that keeps
coming back for the same reason is a missing rule or a missing spec line;
`--calibration` prints recent incorrect findings as the brief every reviewer
reads; duplicate, intentional and nonblocking dispositions are excluded.
New runs also keep the per-invocation ledger from [REVIEW.md](REVIEW.md).
The stats show checks including fix-check, invocation counts and cost
separately from legacy rounds/session totals; unavailable data is unknown.

## A feature merges as one stack

A feature's PRs form one GitHub stack (`gh stack`): its accepted ADR PRs at
the bottom, then each task's PR in the order its review passed, each
targeting the branch below it. A reviewed PR stays open, and the next task
starts on top of it: the issue-state workflow counts a reviewed task of the
same feature as done. When every task has joined, `merge-pr.sh` on the top
PR checks each PR's gates and `gh stack merge` merges them all at once, or
none. So `main` never holds half a feature, and a task never waits for the
CI run and merge of the one below it (2 to 6 minutes per task in the #466
run). A bug merges on its own, and so does a feature's only task unless
the feature has an open ADR PR to stack on.

## `main` and releases

`main` takes changes only through a pull request whose Quality, Fallow and
Console checks passed. That is a ruleset on GitHub, not a convention: agents
push with a maintainer's account, so anything that binds them binds you too,
and nobody bypasses it. Quality is one job that passes only when the static
checks, the unit tests and every e2e shard passed. On a pull request the Console job is skipped when the
PR changes no source, UI, console spec or build file (a skipped job counts
as passed), and runs in Chromium only unless the PR changes `ui/` or the
console specs. Every push to `main` runs it in every browser. Releases therefore run in the Release workflow
(`.github/workflows/release.yml`), started by hand from the Actions tab on
`main`. It runs `release-it`, which bumps the version from the commits since
the last tag, writes `CHANGELOG.md`, pushes the release commit and tag, and
creates the GitHub release; the ruleset lets only GitHub Actions push it.
Agents cannot start it: `gh workflow run` is denied in
`.claude/settings.json`.

## Where ADRs fit

A feature answers _what_ and _why_ in business terms. An ADR answers _how_,
but only for choices that constrain more than one task or would be expensive
to reverse. A task answers _how_ for exactly one PR. Most features never need
an ADR; the ones that fix a protocol shape or an ownership model do. An ADR
is born in a spec session, is _Proposed_ while the feature is `feature:spec`,
_Accepted — not yet implemented_ while the feature is open, and _Accepted_
when it closes. See [adr/README.md](adr/README.md).

## Moving the agent kit to another project

The agents (`.claude/agents/`), skills (`.claude/skills/`) and
`delivery.md` and `testing.md` hold no fact about this project. They rely on
a fixed layout:

- `docs/internal/agent-rules/`: the rules; agents read every file in it.
  `toolchain.md` holds the commands, the slow lane and the project-only
  checks. The other files are this project's own rules.
- `docs/internal/adr/` with a `README.md` index, and
  `docs/internal/templates/` with `feature.md` and `task.md`.
- `.agents/scripts/`: `worktree.sh`, `review-inputs.sh`, `diff-kind.mjs`,
  `stale-refs.sh`, `comments.mjs`, `comment-lint.mjs`, `ci-failures.mjs`,
  `merge-pr.sh`, `pr-body-check.mjs`, `delivery-stats.mjs`, `usage.mjs`,
  `session-env.sh`, `budget-guard.mjs` (a token and turn cap per sub-agent,
  a token and time cap per session, and a stall check),
  `report-guard.mjs` (a stage agent may not stop before its report block),
  `tool-guard.mjs` (a sub-agent may not run a check toolchain.md
  forbids or skip the git hooks, and a stage agent is not started in a
  worktree of its own) and
  `clock.mjs` (the orchestrator's tool results end with the local time,
  and how long the computer slept).
  `worktree.sh` and `ensure-pnpm.sh` are this project's (they install its
  dependencies), and so is `tool-guard.mjs`'s list of checks; the others
  are not. `.agents/briefs/`: the stage agents'
  and reviewers' briefs, and `calibration.md`.
- `.github/workflows/issue-state.yml` and the labels in `.github/labels.json`.

To move it: copy the agents, skills, briefs, scripts, workflow, labels,
`delivery.md`, `testing.md` and the templates; write the new project's
`toolchain.md`, `always-in-scope.md` and its own rules; and rewrite
`worktree.sh` for its package manager.

## Pointers

- Rules: [agent-rules/delivery.md](agent-rules/delivery.md),
  [agent-rules/coding.md](agent-rules/coding.md),
  [agent-rules/always-in-scope.md](agent-rules/always-in-scope.md)
- Templates: [templates/feature.md](templates/feature.md),
  [templates/task.md](templates/task.md)
- Reporter forms: `.github/ISSUE_TEMPLATE/`
- Labels: `.github/labels.json`, synced by `.github/workflows/labels.yml`
- Automation: `.github/workflows/issue-state.yml`
- Skills: `.claude/skills/spec-session`, `.claude/skills/triage-bug`,
  `.claude/skills/deliver` (orchestrator), and the stage wrappers
  `.claude/skills/check-spec`, `.claude/skills/implement`,
  `.claude/skills/review`, `.claude/skills/verify-hardware`, and the
  weekly routines `.claude/skills/harden-tests`,
  `.claude/skills/audit-tests`, `.claude/skills/garden-comments` and
  `.claude/skills/calibrate-reviews`
- Agents: `.claude/agents/` — `implementer`, `reviewer`,
  `hardware-verifier`, `spec-explorer`, `spec-checker`, `bug-triager`
  (the stage instructions), and `spec-reviewer`, `code-reviewer`,
  `claims-reviewer`
- Briefs: `.agents/briefs/` — `implement-<mode>.md`, `review-spec.md`,
  `review-code.md`, `review-claims.md`, `review-later-round.md`,
  `audit-tests-<stage>.md`, `calibration.md`
- Scripts: `.agents/scripts/worktree.sh` (also Claude Code's worktree hook in
  `.claude/settings.json`), `.agents/scripts/ensure-pnpm.sh` and
  `.agents/scripts/session-env.sh` (the session-start hooks: the pinned
  pnpm, and the session's transcript path in the environment),
  `.agents/scripts/review-inputs.sh`, `.agents/scripts/stale-refs.sh`,
  `.agents/scripts/comments.mjs`, `.agents/scripts/comment-lint.mjs` (the
  commit hook and `pnpm lint:comments`), `.agents/scripts/ci-failures.mjs`,
  `.agents/scripts/diff-kind.mjs`, `.agents/scripts/report-guard.mjs`
  (a SubagentStop hook in `.claude/settings.json`),
  `.agents/scripts/budget-guard.mjs` and `.agents/scripts/tool-guard.mjs`
  (PreToolUse hooks), `.agents/scripts/clock.mjs` (a PostToolUse hook),
  `.agents/scripts/merge-pr.sh`, `.agents/scripts/pr-body-check.mjs`,
  `.agents/scripts/delivery-stats.mjs`, `.agents/scripts/usage.mjs`,
  `scripts/slow-e2e.sh`, `scripts/mutate.mjs` (`pnpm mutate`)
- Releases: `.github/workflows/release.yml`
