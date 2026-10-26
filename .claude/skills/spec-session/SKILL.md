---
name: spec-session
description: Run a spec session on an issue with the maintainer — explore, interview in rounds, draft ADRs, write the feature and its tasks, check them, and set them ready after one approval. Use when the user says "spec session for #N", "spec #N", "split #N into tasks" or "revise the spec of #N".
model: opus
effort: medium
---

# Spec session

You turn a request into a feature and its tasks, with the maintainer, in
one session: business and technical together. Rules:
`docs/internal/agent-rules/delivery.md`, above all 3 (the body is the
spec), 4 (reconcile first), 5 (never rewrite a reporter's issue), 6
(outcomes, not implementation) and 7 (a task carries both halves and is
checked before it is ready).

Argument: an issue number, optionally `revise`.

- A `request:new` issue: create the feature from it (step 3), then run the
  whole session on the feature.
- A `feature:spec` feature: run the whole session. When an earlier session
  stopped part way, its Open questions are where this one starts.
- A `task:draft` task: write or finish its Technical spec. Load its
  feature too; explore (step 4) only what the task touches, interview for
  the task's open choices, then write (step 7), check (step 8) and set it
  ready (step 9). When that leaves every task of a `feature:spec` feature
  ready and its Open questions empty, move the feature to
  `feature:planned` too.
- `revise`, on a `feature:spec` or `feature:planned` feature or a task:
  reconcile (step 2), then interview only for the amendments it produced.

A person is always present. Nothing runs this skill unattended.

## 1. Load the issue

Rename the session to `[Spec #N] <issue title>` with
`mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it
with ToolSearch first). Skip it when the tool is missing or declined.

```bash
read -r OWNER REPO < <(gh repo view --json owner,name -q '"\(.owner.login) \(.name)"')
gh api graphql -F owner="$OWNER" -F repo="$REPO" -F number=<N> -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ issue(number:$number){
      id number title body state createdAt lastEditedAt author{login}
      labels(first:10){nodes{name}}
      parent{number title}
      subIssues(first:50){nodes{number title state}}
      comments(first:100){nodes{url author{login} createdAt body}}
    }}}'
```

Refuse a `bug:*` issue: its body belongs to the reporter.

A `Request: #M` line in the body: load issue M the same way; its comments
are part of the discussion.

## 2. Reconcile

The cut-off is `lastEditedAt`, or `createdAt` if the body was never edited.
For every comment on the issue and its linked request created after the
cut-off, decide whether it changes the spec. List one item per proposed
change: the comment's author and URL, and the section it touches. Leave out
comments that change nothing.

Ask the maintainer to accept or reject each item, in one round (step 5).
Fold accepted items into the body in step 7.

## 3. Create the feature from a request

A `request:new` issue only. Write a stub feature: the `Request:` line, the
Problem in the reporter's words, everything else to come.

```bash
gh issue create --title "<title>" --label feature:spec --body-file <file>
gh issue comment <request> --body "Being specified in #<new>. This issue stays open until that feature ships.

*Written by an agent.*"
```

The new body's first line is `Request: #<request>`. Go on with the new
issue.

## 4. Explore before you ask

Before the first question, map relevant code, docs/ADRs and open work.
Follow `docs/internal/EXPLORATION.md`. Use direct searches for straightforward
lookups. For broader independent questions, start bounded `spec-explorer`
helpers together, one per useful area, with `run_in_background: false`.
Give each `issue`, `request`, `area`, commit and concrete `questions`.
Do not require three helpers when direct evidence already answers the scope.

Then, yourself:

1. Open every line an explorer cites. Keep a fact only when the line bears
   it out. A fact never comes from an agent's summary.
2. Collect every contradiction and conflict. Check each against its
   sources; drop the ones that do not hold.
3. Draw today's flow as the user sees it: a Mermaid diagram of at most ten
   boxes, from the facts.

What you kept is the session's ground. A contradiction or conflict is a
question for the first round, unless a rule, an accepted ADR or the code's
handling of the same case already settles it.

**Facts while you wait.** Never ask the maintainer what source can answer.
Each time an answer brings a claim about what code, another tool or a
browser does today, start a `spec-explorer` on it with
`run_in_background: true` and ask the next round without waiting; batch
claims about one area. Another tool is read in its source at the version
this repo uses (`node_modules` for an npm package, the pinned tag
otherwise), never its docs or memory. Reuse verified commit-bound evidence.

## 5. Interview in rounds

Open with what you found and what you think is wanted, in this order:

- today's flow (the diagram from step 4);
- the contradictions and conflicts you kept, one line each;
- your read of the request in one sentence, with a confidence and what is
  missing. For example: "I read this as <...>. Confidence ~40%: missing
  who runs it and what done looks like."

Then walk the decisions as a tree. Business decisions sit at the root: who
it is for, the outcome, the non-goals, how anyone checks it. Technical
decisions hang off them: the ones that need an ADR, then the task list,
the seams the tests drive, and each task's open choices. The frontier is
every decision whose prerequisites are settled.

- **One round asks the whole frontier.** Use `AskUserQuestion`, up to four
  questions per call; a bigger frontier takes more than one call in the
  same round, the decisions most others hang on first. Two questions never
  share a round when one's answer could change the other.
- **Every question carries your recommendation.** Its option comes first,
  its label ends with `(Recommended)`, and the question is worded so that
  picking it is the "yes". Each option says what it costs and where it
  changes things: this repo, another tool, or both.
- **Every question offers `Explain`.** Its last option is `Explain`: "Show
  the problem and what each option brings, then ask again." So a question
  has at most three real options. Keep the question short: one decision,
  about five lines.
- **On `Explain`, explain, then ask again.** In plain text, before
  anything else: what the problem is and why it needs deciding now; for
  each option, what changes, what a user would see, and what it costs,
  each with a picture (a Mermaid diagram, a before-and-after of the
  command and its output, or a short code snippet). Then ask the same
  question again, alone, with the same options. The other answers of that
  round stand.
- **Facts are yours, decisions are the maintainer's.** Ask nothing a rule,
  an accepted ADR or the code's handling of the same case already answers:
  adopt it and say so in the round's text. Ask every other decision, even
  when you are sure of the answer: never answer one yourself.
- **Listen for "should want".** An answer that sounds like good practice
  ("it should be robust", "the standard way") is not yet a decision. Ask
  what they would pick if nobody had to approve it.
- After each round, recompute the frontier. An answer can reopen a branch
  you thought settled, including another question of the same round: put
  it back in the next round.

You are done when the frontier is empty: nothing silently assumed.

**ADRs.** A decision that constrains more than one task or is expensive to
reverse becomes an ADR. Take the next number free on `main` and in open
PRs (`gh pr list --limit 100 --json files -q '.[].files[].path' | grep
docs/internal/adr/`), and open its PR at once, so a session running beside
this one cannot take the number. Draft it in `docs/internal/adr/` at
_Proposed_ on branch `feature/<N>-adr`, with the diagrams
`docs/internal/adr/README.md` asks for, and add its line to Decisions. The maintainer accepts it in the final
approval (step 9), not in a round of its own. An accepted ADR's PR stays
open: it is the bottom of the feature's stack and merges with the
feature's last task (delivery rule 15).

**Stopping part way.** The maintainer may stop the session. Write the
body as far as it is settled (step 7), with every open frontier decision
under Open questions. The feature stays `feature:spec`; the next session
starts there.

## 6. Facts before writing

The interview is over; nothing is played back now (the maintainer approves
once, in step 9). List every claim the design rests on about today: of
this repo, of another tool, of a browser or the machine. Each needs a
source line from an explorer you checked, or from your own read. Wait for
the background explorers; source what is left. A claim you cannot source
is a question: ask it in one round before writing. Start writing only when
every claim has its line.

## 7. Write the feature and its tasks

**The feature.** Write the business sections of
`docs/internal/templates/feature.md` from the interview. Push back on
anything that names a mechanism rather than an outcome, unless the
mechanism is itself a requirement. Add Decisions, Shared values and Tasks.

**Facts.** Each task's Facts table (`docs/internal/templates/task.md`)
holds the claims from step 6 it rests on, with the commit. Also:

1. A value the change sends to another module, process or tool (an id,
   name, key, header, path, flag, JSON shape): find the line that parses or
   validates it, and check the value passes. A pattern gets a table of
   example values, odd ones included.
2. A command, flag, output shape or fixture a Tests line uses: run it on
   `main`, or check that it exists. Cite the output line.

A Source cell that cites docs, memory or "to re-check" is no source: the
body is not posted until it has one, or the claim goes to the maintainer.

**The tasks.** Vertical slices, each a PR one agent can land, ordered so
every task depends only on earlier ones. A small feature is one task. For
each task, write a body from `docs/internal/templates/task.md` with Scope,
Technical spec, Done when, Out of scope and Depends on filled in.

Size each task to about 10 Tests lines (one per behaviour, its cases in
the line) and about 20 modules touched at most: every stage of delivery
grows with them, and a build past about 15 lines has needed a second or
third agent. A task over either splits again along a seam its tests can
drive on their own; when no such seam exists, keep it whole and say why
under its Scope.

**Order.** Most check findings come from text (a behaviour with no test,
two tasks that disagree), so write in this order:

1. The feature's Shared values table, before any task: every value, state,
   error code and message more than one task uses, who writes it, who
   reads it, which wins. Then the Behaviours table: one row per thing an
   invoker (a caller, a user, a stored record, an event) does and sees,
   with its seam, its cases and the task that delivers it; a task's Tests
   lines are these rows and nothing else, one line per row. Then the
   Completion conditions mapped to tasks, and the open work from the
   `work` explorer, each with its Depends on or why none.
2. The tasks in dependency order. Before writing task N, re-read tasks 1
   to N-1 and every ADR section a Shared values row cites.
3. Each task section as its template comment says. The tables carry the
   checks: Facts, the searches behind Modules touched and Other code on
   the same state, the field bounds under Contract and event changes,
   Failure modes, and the quoted rules under Rules in play.

Also:

- One test seam: the highest existing entry point that can see the
  behaviour, ideally one per task, and an existing test file to model the
  tests on. Confirm the seams with the maintainer in the interview.
- A line that claims "every", "any", an order, one write or a choice
  names the cases that prove it (testing rule 10). A claim an existing
  test proves extends that test (testing rule 7).
- A Depends on only when one task uses what the other adds, both change
  the same function or lines, or both trip a project check in
  `toolchain.md`, for another feature's open task too. Tasks that only add
  to one file in different places run at once.
- A Done when line a reviewer can check with the commands `toolchain.md`
  lets an agent run; one that needs the slow lane says so and names its
  test.
- Nothing `always-in-scope.md` covers.

**Self-check before posting.** For each task, in a scratch file, not in
the body:

- **Ledger.** Every sentence in Scope, In short, Technical spec and Done
  when that states a behaviour, "as today" included, one row each: the
  Tests line and case that prove it, or for "as today" the existing test
  that already does, and a wrong build that test would fail on. A sentence with no row, a case no test covers, or a test no
  wrong build would fail: fix the body.
- Every Failure modes row has its Tests line, or says why none; every
  Shared values row the task touches reads the same in the task.
- Every term, quantity and message in In short meets its template rule.
- No Done when line its own Tests or Scope make false.
- Every sentence in any section that says what code, a tool or a browser
  does today names its Facts row; every list given as complete names the
  search that found it.
- `node .agents/scripts/spec-lint.mjs --body-file <file>` (add `--feature`
  for the feature) on each drafted body. Fix every `B` line before
  posting; its header lists what it checks.

**Post.** Do not ask first: a `task:draft` body is safe to post, and the
maintainer approves everything in step 9. Edit the feature in place,
keeping every existing section, and create each task:

```bash
gh issue edit <N> --body-file <file>
gh issue create --title "<title>" --label task:draft --body-file <file>
gh api graphql -F parent="<feature node id>" -F child="<task node id>" -f query='
  mutation($parent:ID!,$child:ID!){
    addSubIssue(input:{issueId:$parent,subIssueId:$child}){ issue{number} }}'
gh issue comment <N> --body "Spec updated: <which sections were added or changed, one line>.

*Written by an agent.*"
```

Get a node id with `gh issue view <n> --json id -q .id`. Bodies you create
end with `*Written by an agent.*`; the spec is never a comment. Never edit a `request:new` or `bug:*` body,
or the body of another feature or its tasks: another session may be
writing it. An overlap with one goes under Depends on in this feature's
task.

## 8. Check the spec

**Lint before any checker.** Run `node .agents/scripts/spec-lint.mjs <n>`
on each posted body (`--feature` for the feature, which also lints its
Behaviours rows against each task's Tests lines and its Depends on graph)
and fix every `B` line before a checker starts; a checker never spends a
round on what the lint finds.

**Round 0, the feature first.** Post the feature body (Decisions, Shared
values, Behaviours, Tasks as a list) before any task body, and start one
`spec-checker` with `#<feature> feature`. Its `undefined`, `boundary`,
`failure-mode` and `fact` findings are decisions: put them to the
maintainer in one interview round, fold the answers into the feature, and
only then write the tasks from the Behaviours table. Its writing findings
you fix yourself. Half of what the task checks used to find were decisions
the interview had not asked.

**Round 1, fresh.** Start `spec-checker` agents with the Agent tool,
`run_in_background: false`, all in one message: one per task, with
`#<task> task`, and one with `#<feature> feature`. Keep each agent's id.

Fix each blocking finding in the body it names. More than half of a
second round's findings sit in text written to fix the first, so after
each fix run the self-check (step 7) again on the lines you changed, and
re-read every task that shares a Shared values row with the one you fixed.
Only you edit the bodies. A finding that needs a decision goes to the
maintainer: all of them in one round, never one at a time.

Notes never start a round. Fix a note when the fix is one line and
decides nothing; leave the rest to the implementer, who closes such gaps
as `Assumption:` lines.

**Round 2, the same checkers.** For every body you changed for a blocking
finding (and the feature, if any task changed), `SendMessage` its checker
`recheck` and the `diff` of the body before and after, nothing else: it
holds its findings and the code it read. One that cannot be resumed is
started fresh with `#<issue> recheck`, its round-1 report and the diff.
Fix what it reports and send that diff to it once more. A finding still
open after that goes to the maintainer in step 9, not to another fix.

Never fix a finding by deciding something the interview left open: put it
to the maintainer in a round. A finding the maintainer accepts stays.

## 9. Approve once, then set the labels

Once every check says `Verdict: ready` or only open findings are left,
ask the maintainer once, with `AskUserQuestion`, above a summary this
short:

```
#<feature> <title>
ADR <nnnn> (PR #<n>): <what it decides, one or two lines>

| Task | What it delivers | Depends on |
| ---- | ---------------- | ---------- |
| #<n> | <one line>       | #<n> or —  |

Check: ready | <n> open findings, one line each
<the chain line of `node .agents/scripts/runnable.mjs <feature>`, e.g. chain 3 of 4 tasks>
```

The options: approve; approve and accept the open findings listed; or
change something, which reopens the interview for that point only. On
approval, set every ADR the feature links to _Accepted — not yet
implemented_ on its PR branch, then:

```bash
gh issue edit <task> --add-label task:ready --remove-label task:draft
gh issue edit <feature> --add-label feature:planned --remove-label feature:spec
```

Depends on sets only the order the `deliver` skill runs the tasks in.

## Make it easy to follow

The maintainer approves what they understand. Context they may lack: three
lines at most in a question; the rest waits for `Explain`.

- A picture is a Mermaid diagram of today's flow and the proposed one (at
  most about ten boxes), a before-and-after of the command and its output,
  or a short code snippet.
- Use a user's words. Explain a term from the code, an ADR or a rule the
  first time, with an example, and add it to Words used. Say the reason,
  never a rule or ADR number.
- A rule that accepts, rejects or matches input: show a table of example
  inputs, odd cases included, with today's result and the proposed one.
  Fill today's column by running the tool on `main`.
- For technical questions, draw the modules involved (changed ones
  marked), and a sequence diagram for any request that crosses a process
  or network hop, failure reply included.

Write as rule 12 asks: short sentences, common words. An agent builds
exactly what the spec says: cut every sentence that does not constrain it.
