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
| `feature:ready`   | Business sections and ADRs accepted; agents do the rest. |
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
   Decisions. The session edits the body and leaves a one-line "Spec
   updated" comment. It ends with `check-spec`: a fresh agent reads the
   body as posted against the rules, the ADRs and the code. It first plans
   the change file by file and runs a pre-mortem, then gives every category
   a status: contradictions, lines nobody could check, behaviour no test
   pins, failure modes no line answers, existing code on the same state no
   line names, lists the code contradicts, and undefined terms. You and the
   session fix those in the body.
5. Once Open questions is empty, every linked ADR is accepted and the spec
   check has nothing open, the maintainer adds `feature:ready`. The ADRs
   move to _Accepted — not yet implemented_.
6. An agent running `deliver` claims it, works on `feature/<n>`, has the
   change reviewed and merged through the gate (below), and the PR body
   walks every completion condition. Merge closes the feature, and its ADRs
   flip to _Accepted_.

## A feature, split into tasks

Steps 1 to 4 are the same, but the second session ends differently: instead
of a Technical spec section on the feature, it produces sub-issues. There
are two ways in. Attended, you sit through the split and agree the task
list and test seams (steps 5 and 6). Unattended, the second session settles only
the decisions that need ADRs; you accept those, add `feature:ready`, and
run `/deliver <feature>`. The run writes each task's technical spec, has
`check-spec` read the tasks as posted and fixes what it finds, marks them
ready, and then delivers the tasks in dependency order, two at a
time, merging each through the gate. A small gap a task leaves open it
closes the conservative way and lists as an `Assumption:` line in the PR,
for you to see. It stops and hands back to you only for a new ADR, a
comment that would change the spec, a choice a user would notice that
nobody made, a blocking review finding it could not settle, or a
real-device check it could not run. It ends with one comment on the
feature listing what merged, what parked and why, and what is still
waiting.

5. Each task is a native sub-issue of the feature, labelled `task:draft`, with
   a body from [templates/task.md](templates/task.md): Scope, Technical spec,
   Facts, Done when, Out of scope and Depends on. Every fact cites the line
   or command output it was read from. Once the tasks exist, `check-spec` reads them as posted, one checker per task and
   one for the feature as a whole, and the session fixes what they find,
   including tasks that overlap without a Depends on, in this feature or
   another. After the second check, a closure check confirms each fix closed
   its finding; one that did not goes to you. The feature
   becomes `feature:planned` and keeps only its business spec, Decisions and
   the task list.
6. When the check passes, the session sets every task `task:ready`. Your
   say is the split interview; move a task back to `task:draft` to hold it.
   Depends on sets only the order: `deliver` starts a task once each
   dependency is closed or is a task of the same feature whose PR passed
   review.
7. Agents claim `task:ready` issues one PR each, on `task/<n>`, each PR
   reviewed before it leaves draft (below).
8. Verification is part of delivery. Every task PR walks its Done when, and
   the PR that closes the last open sub-issue also walks the feature's
   Completion conditions. When that last sub-issue closes, the automation
   comments on the feature, and the maintainer closes it. If the feature
   came from a request, the request closes on its own with a pointer to the
   feature.

## Review, verification and merge

`deliver` never writes code itself. It hands each stage to a new background
agent in `.claude/agents/` that runs on the model and effort its
frontmatter pins — `implementer` on Sonnet, `reviewer`, `bug-triager` and
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
caller or user could see. Each push cancels the CI
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

A PR leaves draft reviewed; it is not reviewed on arrival. The `review`
skill builds the reviewers' inputs with `.agents/scripts/review-inputs.sh`
(rules, ADRs and briefs from `main`, so a PR cannot rewrite what it is
judged by) and spawns reviewer agents from `.claude/agents/`, each reading
its brief from `.agents/briefs/`, with its model pinned and its tools
limited. None has seen the delivering session, the PR body or another
reviewer's findings, and each reads first `.agents/briefs/calibration.md`,
the findings rejected in the last four weeks, which the weekly
`calibrate-reviews` routine regenerates.

- The spec reviewer gets the issue, its parent, its ADRs,
  `always-in-scope.md`, the PR's `Assumption:` lines, the diff, and every
  change made to the spec's tests after they were committed red (the final
  diff cannot show a red test deleted or loosened on the way to green). It
  answers whether every line of the spec is delivered, whether the diff
  does anything the spec did not ask for, whether each test proves the
  claim in its title, and whether each assumption is the conservative one.
- The code reviewer gets the same specification, the agent rules, the ADR
  index and the diff, in its own worktree, and holds two lenses. One looks
  for the input, state or interleaving that makes a changed function wrong,
  and for other code acting on the same state. The other looks for tests
  that cannot fail for the reason their title gives, breaking code to see
  what stays green, and for broken rules. It may write one test of its own
  to prove an interleaving. A diff over 1,500 changed lines gets two
  reviewers, one per lens. `pnpm check` and the browser and slow lanes are
  left to the git hooks and CI.
- The claims reviewer gets the diff and the output of
  `.agents/scripts/stale-refs.sh`, which lists every line in the repo that
  still names a path, declaration or quoted string the diff removed. It
  checks that comments, docs, test titles and messages are true of the code.

Whether a comment may exist at all is not a review's question any more. A
comment starts with `why:` or goes (architecture rule 17), and
`.agents/scripts/comment-lint.mjs` rejects the rest in the commit hook and
in CI. A Haiku reviewer used to judge that rule: on one PR it raised 155
findings, each verified by Opus and fixed by Sonnet, and a third of its
findings on another were rejected as "gives a why". Older comments are the
weekly `garden-comments` routine's.

How many of these reviews a PR gets depends on its diff's kind
(`.agents/scripts/diff-kind.mjs`): an ADR-only diff gets the spec review
alone; a docs-only or comments-only diff the spec and claims reviews; a
tests-only diff all three with the tests lens only; any other diff all
three, and a large one (over 1,500 changed lines) two code reviewers.

The code reviewer sees the spec as well as the rules. It used to be blind
to the issue so that a conflict between the spec and a rule would surface
rather than be resolved silently; what it produced instead was findings
about intent ("the spec decides this interim on purpose", "spec line 179
asks for it as a guard"), each verified and rejected. The conflict still
surfaces: it is a finding of its own class, never resolved by the reviewer,
and the maintainer sees it under Spec needs.

Every finding is blocking — it breaks behaviour, leaves wrong state, states
something false, or breaches a rule, an ADR or the spec — or a note, and
names its class: the general rule it breaks. A review returns at most five
notes, each a possible wrong behaviour or state. Only blocking findings are
verified: the agent reproduces each against the code, has the implementer
fix it and every other instance of its class, and lists what it rejects in
the PR body under `## Review`, one line each, tagged `spec:`, `code:` or
`claims:`, with the reason. A confirmed finding is *src* when its fix must
change production source and *text* when a test, a comment, a doc or an
assumption line is enough. Rounds are at most two, plus one fix check.
Round 1 reviews the whole diff. Round 2 runs only after a confirmed *src*
finding and reviews the fix alone; a *src* finding it confirms gets one fix
and one fix check of that fix; one still confirmed then is a contested
change: the agent hands off with it and leaves the PR in draft. *Text*
findings never park a PR and get no further review: they are fixed once, in
tests, comments and docs only. A check of those fixes ran in the #466
delivery three times and found one docs line a round 1 note had already
named. Five rounds used to be allowed; rounds 3 to 5 confirmed almost
nothing a person then kept. Notes are not verified and never start a round;
they reach you once, as one "Review notes" comment on the PR, and become
issues only when you open one.

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

Three transitions are judgments and stay manual on purpose: `bug:new` to
`bug:triage`, `bug:triage` to `bug:ready`, and `feature:spec` to
`feature:ready`. Each is one click. Tasks need no click: the spec session
marks them ready once their check passes.

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
`--calibration` prints the recent ones as the brief every reviewer reads.

## A feature merges as one stack

A feature's PRs form one GitHub stack (`gh stack`): its accepted ADR PRs at
the bottom, then each task's PR in the order its review passed, each
targeting the branch below it. A reviewed PR stays open, and the next task
starts on top of it: the issue-state workflow counts a reviewed task of the
same feature as done. When every task has joined, `merge-pr.sh` on the top
PR checks each PR's gates and `gh stack merge` merges them all at once, or
none. So `main` never holds half a feature, and a task never waits for the
CI run and merge of the one below it (2 to 6 minutes per task in the #466
run). A single task, a bug, or a feature delivered as one PR merges on its
own, as before, unless its feature has an open ADR PR to stack on.

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
  `.claude/skills/garden-comments` and `.claude/skills/calibrate-reviews`
- Agents: `.claude/agents/` — `implementer`, `reviewer`,
  `hardware-verifier`, `spec-checker`, `bug-triager` (the stage
  instructions), and `spec-reviewer`, `code-reviewer`, `claims-reviewer`
- Briefs: `.agents/briefs/` — `implement-<mode>.md`, `review-spec.md`,
  `review-code.md`, `review-claims.md`, `review-later-round.md`,
  `calibration.md`
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
