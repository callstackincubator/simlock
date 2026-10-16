---
name: spec-session
description: Run a spec session on a GitHub issue — explore the code, docs, ADRs and open work first, then interview the maintainer in rounds on business and technical decisions together, draft any ADRs, and write the feature's business sections and its task sub-issues in one session; it ends with the spec-checker agent reading every posted body, and its findings are fixed before any task is set task:ready. Always reconciles comments posted since the body was last edited before writing anything. Use when the user says "spec session for #N", "write the spec for #N", "spec #N", "split #N into tasks", or "revise the spec of #N".
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

Before the first question, map what exists today. Start `spec-explorer`
agents with the Agent tool, all in one message, with
`run_in_background: false`, one per area: `code`, `docs` and `work`, plus
`tool:<name>` for every other tool the request involves. Each prompt is
`key: value` lines: `issue`, `request` (the request in a few lines),
`area`, and `questions` when you already have some.

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

A fact you need later: one more `spec-explorer`, now with
`run_in_background: true` and the question under `questions`. Only the
questions that depend on its answer wait for it. Never ask the maintainer
something an explorer can find.

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

You are done when the frontier is empty: every decision asked and
answered, nothing silently assumed.

**ADRs.** A decision that constrains more than one task or is expensive to
reverse becomes an ADR. Draft it in `docs/internal/adr/` at status
_Proposed_ on branch `feature/<N>-adr`, with the diagrams
`docs/internal/adr/README.md` asks for, open its PR, and add its line to
Decisions. Ask the maintainer to accept it in the next round. No task is
set ready while it is _Proposed_. An accepted ADR's PR stays open: it is
the bottom of the feature's stack and merges with the feature's last task
(delivery rule 15).

**Stopping part way.** The maintainer may stop the session. Write the
body as far as it is settled (step 7), with every open frontier decision
under Open questions. The feature stays `feature:spec`; the next session
starts there.

## 6. Play it back

Before writing anything, play the result back in one message and ask for
an explicit yes:

```
Who:          <one line>
Today:        <one line, from the facts>
Outcome:      <one line>
Done when:    <the completion conditions, one line each>
Decisions:    <one line each, ADRs named>
Out of scope: <one line>
Tasks:        <the order as a Mermaid flowchart, one line per task>
```

Also show the user flow diagram and one before-and-after example. "Sounds
good" is not a yes: ask what they would change. Write only after a clear
yes.

## 7. Write the feature and its tasks

**The feature.** Write the business sections of
`docs/internal/templates/feature.md` from the interview. Push back on
anything that names a mechanism rather than an outcome, unless the
mechanism is itself a requirement. Add Decisions, Shared values and Tasks.

**Facts.** Each task's Facts table (`docs/internal/templates/task.md`)
starts from the facts you kept in step 4. For every other fact the design
rests on:

1. Ask a `spec-explorer`, then open the line it cites yourself.
2. A value the change sends to another module, process or tool (an id,
   name, key, header, path, flag, JSON shape): find the line that parses or
   validates it, and check the value passes. A pattern gets a table of
   example values, odd ones included.
3. A command, flag, output shape or fixture a Tests line uses: run it on
   `main`, or check that it exists. Cite the output line.
4. When the feature copies another tool's behaviour, read how that tool
   does it before you propose anything.

A fact you cannot source is an open question: ask.

**The tasks.** Vertical slices, each a PR one agent can land, ordered so
every task depends only on earlier ones. A small feature is one task. For
each task, write a body from `docs/internal/templates/task.md` with Scope,
Technical spec, Done when, Out of scope and Depends on filled in.

Size each task to about 30 Tests lines and about 20 modules touched at
most. Every stage of delivery grows with them: a task with 85 Tests lines
fills an agent's context and a session's budget, and its review rounds find
more each time. A task over either splits again along a seam its tests can
drive on their own; when no such seam exists, keep it whole and say why
under its Scope.

**Order.** The spec checker's findings mostly come from text, not from
code nobody read: a behaviour with no test, an outcome nobody answered,
two tasks that say different things. So write in this order:

1. The feature's Shared values table, before any task: every value, state,
   error code and message more than one task uses, who writes it, who
   reads it, which wins. Then the Completion conditions mapped to tasks,
   and the open work from the `work` explorer, each with its Depends on or
   why none.
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
- Two tasks run one after the other (the later lists the earlier under
  Depends on) only when one uses what the other adds, both change the same
  function or the same lines, or both trip a project check in
  `toolchain.md`. Two tasks that only add to the same file in different
  places run at once: the one that merges second takes the base branch.
  That holds for an open task of another feature too.
- A Done when line a reviewer can check with the commands `toolchain.md`
  lets an agent run; one that needs the slow lane says so and names its
  test.
- Nothing `always-in-scope.md` covers.

**Self-check before posting.** For each task, in a scratch file, not in
the body:

- **Ledger.** Every sentence in Scope, In short, Technical spec and Done
  when that states a behaviour, "as today" included, one row each: the
  Tests line and case that prove it, and a wrong build that test would
  fail on. A sentence with no row, a case no test covers, or a test no
  wrong build would fail: fix the body.
- Every Failure modes row and line has its Tests line, or says why none.
- Every term, quantity and message in In short meets its template rule.
- Every Shared values row the task touches reads the same in the task.
- No Done when line its own Tests or Scope make false.
- Every list given as complete (ports, callers, files, steps, triggers)
  names the search that found it.

**Post.** Show the feature body and the task bodies and wait for a yes.
Then edit the feature in place, keeping every existing section, and create
each task:

```bash
gh issue edit <N> --body-file <file>
gh issue create --title "<title>" --label task:draft --body-file <file>
gh api graphql -F parent="<feature node id>" -F child="<task node id>" -f query='
  mutation($parent:ID!,$child:ID!){
    addSubIssue(input:{issueId:$parent,subIssueId:$child}){ issue{number} }}'
gh issue comment <N> --body "Spec updated: <which sections were added or changed, one line>.

*Written by an agent.*"
```

Get a node id with `gh issue view <n> --json id -q .id`. Issue bodies you
create end with `*Written by an agent.*`. Never post the spec, or a
summary of it, as a comment. Never edit a `request:new` or `bug:*` body.

## 8. Check the spec

The check reads the bodies as posted. Start `spec-checker` agents with the
Agent tool, `run_in_background: false`, all in one message: one per task,
with `#<task> task`, and one with `#<feature> feature`.

Fix each blocking finding in the body it names. More than half of a
second round's findings sit in text written to fix the first, so after
each fix run the self-check (step 7) again on the lines you changed, and
re-read every task that shares a Shared values row with the one you fixed.
Only you edit the bodies.

Notes never start a round. Fix a note when the fix is one line and
decides nothing; leave the rest to the implementer, who closes such gaps
as `Assumption:` lines.

Then run the check once more for every issue whose body you changed for a
blocking finding (and the feature check, if any task changed). Fix what
its blocking findings report; then start one `spec-checker` with
`#<issue> closure` and the blocking finding lines you fixed, for each body
you changed after the second run. A finding it reports open is not fixed
again: ask the maintainer.

Never fix a finding by deciding something the interview left open: put it
to the maintainer in a round. A finding the maintainer accepts stays.

## 9. Set the labels

Once the check says `Verdict: ready`, or every open blocking finding is
one the maintainer accepted, and no ADR the feature links is still _Proposed_:

```bash
gh issue edit <task> --add-label task:ready --remove-label task:draft
gh issue edit <feature> --add-label feature:planned --remove-label feature:spec
```

Depends on sets only the order the `deliver` skill runs the tasks in.

## Make it easy to follow

The maintainer approves what they understand. A question is short; the
`Explain` option brings the full context on demand.

- A picture is a Mermaid flowchart or sequence diagram of today's flow and
  the proposed one, a before-and-after example of the command and its
  output, or a short code snippet. A diagram has at most about ten boxes;
  split a bigger flow.
- One decision per question, about five lines. Context the maintainer may
  lack: three lines at most; the rest waits for `Explain`.
- Use a user's words. The first time a term from the code, an ADR or a
  rule appears, say what it means in plain words with an example, and add
  it to the body's Words used section. Never give a rule or ADR number as
  the reason for something; say the reason.
- A rule that accepts, rejects or matches input: show a table of example
  inputs, odd cases included, with today's result and the proposed one.
  Fill today's column by running the tool on `main`.
- For technical questions, draw a Mermaid dependency flowchart of the
  modules involved (changed ones marked), and a Mermaid sequence diagram
  for any request that crosses a process or network hop, failure reply
  included.
- Fill "How it works for the user", "Examples", "What could go wrong" and
  "Words used" (feature) and "In short" (task) as the templates say.

Write the spec as rule 12 asks: short sentences, common words, one idea per
sentence. An agent builds exactly what the spec says, so cut every sentence
that does not constrain the build.
