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
   body as posted against the rules, the ADRs and the code, and reports
   contradictions, lines nobody could check, and failure modes no line
   answers. You and the session fix those in the body.
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
are two ways in. Attended, you sit through the split and tick each task's
approval box (steps 5 and 6). Unattended, the second session settles only
the decisions that need ADRs; you accept those, add `feature:ready`, and
run `/deliver <feature>`. The run writes each task's technical spec, has
`check-spec` read the tasks as posted and fixes what it finds, ticks the
boxes itself, and then delivers the tasks in dependency order, two at a
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
   Done when, Out of scope, Depends on, and an approval checkbox. Once the
   tasks exist, `check-spec` reads them as posted, and the session fixes what
   it finds, including tasks that overlap without a Depends on. The feature
   becomes `feature:planned` and keeps only its business spec, Decisions and
   the task list.
6. The maintainer ticks the approval box on each task, once, at planning
   time. From then on the automation promotes a task to `task:ready` the
   moment its box is ticked, its Technical spec has content, and every issue
   under Depends on is closed. Nobody re-reads the dependency graph by hand.
7. Agents claim `task:ready` issues one PR each, on `task/<n>`, each PR
   reviewed before it leaves draft (below). As tasks close, the ones they
   unblocked become ready on their own.
8. Verification is part of delivery. Every task PR walks its Done when, and
   the PR that closes the last open sub-issue also walks the feature's
   Completion conditions. When that last sub-issue closes, the automation
   comments on the feature, and the maintainer closes it. If the feature
   came from a request, the request closes on its own with a pointer to the
   feature.

## Review, verification and merge

`deliver` never writes code itself. It hands each stage to a background
agent in `.claude/agents/` that runs on the model and effort its
frontmatter pins — `implementer` on Sonnet, `reviewer`, `bug-triager` and
`spec-checker` on Opus — up to two issues at once, and reasons only over the
fixed report each one returns. The stage skills of the same names are thin
wrappers that start those agents when a person invokes them, after renaming the session
so its title names the issue or PR. `deliver` and `spec-session` run in
the session that invoked them; their frontmatter pins Opus only until the
next message, so an unattended run keeps it and an attended one returns to
the session's model after the first reply. `implement` commits the spec's
tests red first and opens a draft PR, so CI runs from the first push; it
then turns them green in commits that each lower the failing count, and
runs `pnpm mutate` so every changed line is shown to matter before anyone
reviews it.

A spec never answers every question. What any change includes without
asking — docs it makes false, both `EVENTS.md` files, a test for every new
path, Fallow entries — is listed once, in
[agent-rules/always-in-scope.md](agent-rules/always-in-scope.md). When the
body, the rules and the ADRs all leave a smaller gap open, `implement`
closes it the conservative way and records it as an `Assumption:` line in
the PR body. An assumption is a proposal you can see and reject, not a
change to the spec.
The run parks only for a contradiction with the body, a rule or an accepted
ADR, or a choice a user would notice that nobody made.

A PR leaves draft reviewed; it is not reviewed on arrival. The `review`
skill builds the reviewers' inputs with `.agents/scripts/review-inputs.sh`
and spawns the two reviewer agents in `.claude/agents/`, which pin Opus
at high effort and limit the tools each may use. Neither has seen the
delivering session, and neither sees what the other sees. The spec reviewer gets the issue, its
parent, its ADRs, `always-in-scope.md`, the PR's `Assumption:` lines and
the diff, and answers whether every line of the spec is delivered, whether
the diff does anything the spec did not ask for, whether each test proves
the claim in its title, and whether each assumption is the conservative
one. It also gets every change made to the spec's tests after they were
committed red, because the final diff cannot show a red test that was
deleted or loosened on the way to green. The code reviewer gets the agent
rules, the ADR index and the diff, never the issue, and answers what input
or interleaving makes each changed function wrong and whether a rule is
broken. It works in its own worktree and proves claims with the affected
test file only, breaking code at most three times on its riskiest claims;
`pnpm check`, `pnpm mutate` and the browser and slow lanes are left to the
implementer and CI. The two are blind to each other on purpose: a reviewer
holding both the spec and the rules resolves a conflict between them
silently, and the maintainer wants to see that conflict, because it usually
means the spec is missing a line.

Every finding is blocking — it breaks behaviour, leaves wrong state, or
breaches a rule, an ADR or the spec — or a note. Only blocking findings are
verified: the agent reproduces each against the code, fixes what it
confirms, and lists what it rejects in the PR body under `## Review`, one
line each, tagged `spec:` or `code:`, with the reason. A confirmed fix
re-runs the review that raised it, once. A blocking finding still open
after that is a contested change: the agent hands off with it and leaves
the PR in draft. Notes are not verified and never start a round; they
reach you once, as one "Review notes" comment on the PR. An ADR-only PR
gets the spec review alone.

A Done when line that needs a real simulator or emulator runs through the
`verify-hardware` skill and `scripts/slow-e2e.sh`, one lane per machine, in
parallel with the reviews and on the same commit. A hardware failure joins
the review's fixes in one fix run. A PR whose hardware check could not run
gets `needs-hardware` and waits for you. Everything else that passes is
merged by the agent through `.agents/scripts/merge-pr.sh`, which refuses a
draft, a `needs-hardware` label, a missing Review section, a "spec needs"
line, red CI, or a conflict. The same two reviews run on a person's PR when
the maintainer asks; there the agent posts the findings as a comment and
pushes nothing.

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
and nothing else. The repo's skills — `spec-session`, `triage-bug`,
`deliver`, `review` — handle the transitions an agent makes as part of its
own procedure, and the reviews are the delivering agent's job, not CI's.

Three transitions are judgments and stay manual on purpose: `bug:new` to
`bug:triage`, `bug:triage` to `bug:ready`, and `feature:spec` to
`feature:ready`. Each is one click. The approval box on each task is a
fourth, except for the tasks of a `feature:ready` feature, where your
`feature:ready` was the approval.

## Watching the pipeline

`node .agents/scripts/delivery-stats.mjs` turns the PRs merged in the last
five weeks into one row per week: for each review, how many blocking
findings it raised and how many were confirmed and fixed; the notes both
raised; how many PRs needed no fix, or a second round; mutants left alive;
handoffs. PRs from before the blocking/note split count every finding they
raised. Below the table it lists
this week's rejected findings, handoffs and PRs waiting on hardware. A
weekly routine runs it and suggests at most one change. A review whose
blocking findings are mostly rejected costs a verification each and
changes nothing: tune its brief, or what `always-in-scope.md` lists. A rejection that keeps coming back for the same
reason is a missing rule or a missing spec line.

## `main` and releases

`main` takes changes only through a pull request whose Quality, Fallow and
Console checks passed. That is a ruleset on GitHub, not a convention: agents
push with a maintainer's account, so anything that binds them binds you too,
and nobody bypasses it. Releases therefore run in the Release workflow
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

## Pointers

- Rules: [agent-rules/delivery.md](agent-rules/delivery.md),
  [agent-rules/always-in-scope.md](agent-rules/always-in-scope.md)
- Templates: [templates/feature.md](templates/feature.md),
  [templates/task.md](templates/task.md)
- Reporter forms: `.github/ISSUE_TEMPLATE/`
- Labels: `.github/labels.json`, synced by `.github/workflows/labels.yml`
- Automation: `.github/workflows/issue-state.yml`
- Skills: `.claude/skills/spec-session`, `.claude/skills/triage-bug`,
  `.claude/skills/deliver` (orchestrator), and the stage wrappers
  `.claude/skills/check-spec`, `.claude/skills/implement`,
  `.claude/skills/review`, `.claude/skills/verify-hardware`
- Agents: `.claude/agents/` — `implementer`, `reviewer`,
  `hardware-verifier`, `spec-checker`, `bug-triager` (the stage
  instructions), and `spec-reviewer`, `code-reviewer`
- Scripts: `.agents/scripts/worktree.sh` (also Claude Code's worktree hook in
  `.claude/settings.json`), `.agents/scripts/ensure-pnpm.sh` (the session-start
  hook; installs the pinned pnpm into a cache when PATH lacks it),
  `.agents/scripts/review-inputs.sh`, `.agents/scripts/merge-pr.sh`,
  `.agents/scripts/delivery-stats.mjs`,
  `scripts/slow-e2e.sh`, `scripts/mutate.mjs` (`pnpm mutate`)
- Releases: `.github/workflows/release.yml`
