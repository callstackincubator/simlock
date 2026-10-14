---
name: spec-session
description: Run a spec session on a GitHub issue — turn a request into a feature spec, write or amend its business section, add the technical section, or split it into task sub-issues; technical and split end with the spec-checker agent reading the posted body, and its findings are fixed before any ready label is set, and split ends with every task task:ready. Always reconciles comments posted since the body was last edited before writing anything. Use when the user says "spec session for #N", "write the spec for #N", "add the technical spec to #N", or "split #N into tasks", and when the deliver skill specifies a feature:ready feature unattended.
model: opus
effort: medium
---

# Spec session

You write the body of a `feature:*` or `task:*` issue for the maintainer.
Rules: `docs/internal/agent-rules/delivery.md`, above all 3 (the body is the
spec), 4 (reconcile first), 5 (never rewrite a reporter's issue), 6
(outcomes, not implementation) and 7 (a task carries both halves and is
checked before it is ready).

Argument: an issue number, optionally a mode (`business`, `technical`,
`split`, `revise`), optionally `unattended`. No mode: infer it from the body
and confirm with the user before writing.

**Unattended** is only for `split` on a `feature:ready` feature, run by the
`deliver` skill. `feature:ready` already accepted the business sections and
every linked ADR (rule 1), so ask nobody: where an attended session would
ask, decide from the business sections, the ADRs and the codebase. Stop and
report why when:

- reconciling finds a comment that would change the spec;
- a decision needs a new ADR (it constrains more than one task, or is
  expensive to reverse);
- a question only the maintainer can answer remains, including a spec-check
  finding (step 5) the accepted business sections do not settle.

## 1. Load the issue

Rename the session to `[Spec #N, <mode>] <issue title>` with
`mcp__ccd_session_mgmt__set_session_title` (`session_id: "self"`; load it
with ToolSearch first). Skip it when unattended (the delivery run owns the
title), or when the tool is missing or declined.

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

Refuse a `bug:*` issue, and a `request:new` issue in any mode other than
creating a feature from it: those bodies belong to the reporter.

A `Request: #M` line in the body: load issue M the same way; its comments
are part of the discussion.

## 2. Reconcile

The cut-off is `lastEditedAt`, or `createdAt` if the body was never edited.
For every comment on the issue and its linked request created after the
cut-off, decide whether it changes the spec. List one item per proposed
change: the comment's author and URL, and the section it touches. Leave out
comments that change nothing.

Ask the maintainer to accept or reject each item, one at a time.
Unattended, any item stops the session. Fold accepted items into the body
in step 4. Do not start step 3 until every item has an answer.

## 3. Do the session

Every mode is an interview: one question at a time, each with your
recommended answer. Explore the codebase instead of asking whenever it can
answer. Ask nothing a rule, an accepted ADR or the code's handling of the
same case already answers: adopt it and say so. Use the technique of the
`interview-me` and `grill-me` skills.

**Facts** (`technical` and `split`). Before you write a Technical spec or a
task body, fill its Facts table (`docs/internal/templates/task.md`): every
fact the design rests on about existing code, another tool or the machine.

1. List the questions the design depends on. Send them to `Explore` agents
   with `model: haiku`, one per repository, all in one message, each ending
   `Answer with path:line lines only, one per line, no prose.` Where another
   tool's source lives: `toolchain.md`, "Other tools' source".
2. Read every line they return yourself before you write its row. A fact
   never comes from an agent's summary.
3. A value the change sends to another module, process or tool (an id,
   name, key, header, path, flag, JSON shape): find the line that parses or
   validates it, and check the value passes. A pattern gets a table of
   example values, odd ones included.
4. A command, flag, output shape or fixture a Tests line uses: run it on
   `main`, or check that it exists. Cite the output line.
5. When the feature copies another tool's behaviour, read how that tool
   does it before you propose anything.

A fact you cannot source is an open question: attended, ask; unattended,
stop.

**Creating a feature from a request** (`request:new` issue given):
interview for the business sections of `docs/internal/templates/feature.md`,
then:

```bash
gh issue create --title "<title>" --label feature:spec --body-file <file>
gh issue comment <request> --body "Being specified in #<new>. This issue stays open until that feature ships.

*Written by an agent.*"
```

The new body's first line is `Request: #<request>`.

**`business`**: write or amend the sections Problem through Open questions.
Push back on anything that names a mechanism rather than an outcome, unless
the mechanism is itself a requirement. Leave Open questions non-empty while
questions remain: the feature does not leave `feature:spec` until it is
empty.

**`technical`** (a feature delivered as one PR): fill the Technical spec
section. First ask whether any decision here constrains more than one future
change or would be expensive to reverse. Each such decision becomes an ADR:
draft it in `docs/internal/adr/` at status _Proposed_ on branch
`feature/<N>-adr`, with the diagrams `docs/internal/adr/README.md` asks for,
open its PR, and add its line to Decisions. Tell the maintainer the feature
cannot leave `feature:spec` until that ADR is accepted. An accepted ADR's PR
stays open: it is the bottom of the feature's stack and merges with the
feature's last task (delivery rule 15). Write only what
`docs/internal/agent-rules/always-in-scope.md` does not cover. End with the
spec check (step 5) on the posted body.

**`split`**: interview for the task list: vertical slices, each a PR one
agent can land, ordered so every task depends only on earlier ones. For each
task, write a body from `docs/internal/templates/task.md` with Scope,
Technical spec, Done when, Out of scope and Depends on filled in.

Size each task to about 30 Tests lines and about 20 modules touched at
most. Every stage of delivery grows with them: a task with 85 Tests lines
fills an agent's context and a session's budget, and its review rounds find
more each time. A task over either splits again along a seam its tests can
drive on their own; when no such seam exists, keep it whole and say why
under its Scope.

Write each body so the spec check finds nothing:

- no Done when line its own Tests or Scope make false, none a reviewer
  could not check, no failure mode left unanswered;
- a Tests line for every behaviour the body states, "as today" included;
- a seam for the tests: the entry point they drive. Prefer an existing seam
  to a new one, the highest one that can see the behaviour, and as few as
  possible, ideally one. Name an existing test file to model them on.
  Attended, confirm the seams with the maintainer in one question;
- under "Other code on the same state", every existing component that acts
  on the state the task changes, found by searching, and which one wins
  when both act;
- every list given as complete (ports, callers, files, steps, triggers)
  checked against a search of the code;
- two tasks run one after the other (the later lists the earlier under
  Depends on) only when one uses what the other adds, both change the same
  function or the same lines, or both trip a project check in
  `toolchain.md`. Two tasks that only add to the same file in different
  places run at once: the one that merges second takes the base branch.
  That holds for an open task of another feature too;
- every sentence about today's behaviour names its Facts row;
- every value more than one task uses in the feature's Shared values
  table, linked from each task, never restated;
- a Done when line that needs the slow lane says so and names its test, as
  `toolchain.md` asks;
- nothing `always-in-scope.md` covers.

Then create each task:

```bash
gh issue create --title "<title>" --label task:draft --body-file <file>
gh api graphql -F parent="<feature node id>" -F child="<task node id>" -f query='
  mutation($parent:ID!,$child:ID!){
    addSubIssue(input:{issueId:$parent,subIssueId:$child}){ issue{number} }}'
```

Get a node id with `gh issue view <n> --json id -q .id`. Run the spec check
(step 5) on the feature: it reads every task you created. Then remove the
Technical spec section from the feature body, add the Tasks section the
feature template describes (the order as a diagram, then one entry per task
with what it changes for the user and its risk), and change the label:

```bash
gh issue edit <feature> --add-label feature:planned --remove-label feature:spec
```

Unattended, remove `feature:ready` instead of `feature:spec`.

Once the spec check (step 5) passes, set every task ready, attended or
not. Depends on sets only the order the `deliver` skill runs them in:

```bash
gh issue edit <task> --add-label task:ready --remove-label task:draft
```

**`revise`**: the reconcile step, plus the amendments it produced.

**Make it easy to follow.** The maintainer approves what they understand:
show, then explain, then ask.

- Open every question with its picture: a Mermaid flowchart or sequence
  diagram of today's flow and the proposed one, or a before-and-after
  example of the command and its output. Then ask, with your recommended
  answer and one line on what each option costs.
- Use a user's words. The first time a term from the code, an ADR or a rule
  appears, say what it means in plain words with an example, and add it to
  the body's Words used section. Never give a rule or ADR number as the
  reason for something; say the reason.
- One decision per question, about five lines plus its picture; split
  anything longer. Context the maintainer may lack: three lines at most.
- A rule that accepts, rejects or matches input: show a table of example
  inputs, odd cases included, with today's result and the proposed one.
  Fill today's column by running the tool on `main`.
- Before writing the body, play the result back: the user flow diagram, the
  example, and what will and will not change. Write only after the
  maintainer says it matches what they meant.
- Each option says where it changes things: this repo, another tool, or
  both.
- In a Technical spec, draw a Mermaid dependency flowchart of the modules
  involved (changed ones marked), and a Mermaid sequence diagram for any
  request that crosses a process or network hop, failure reply included.
  Use the same diagrams for technical questions.
- Fill "How it works for the user", "Examples", "What could go wrong" and
  "Words used" (feature) or "In short" (task) as the template says. A
  diagram has at most about ten boxes; split a bigger flow.

Write the spec as rule 12 asks: short sentences, common words, one idea per
sentence. An agent builds exactly what the spec says, so cut every sentence
that does not constrain the build.

## 4. Write back and leave a marker

A person is present: show the new body and wait for a yes before posting.
Unattended: post directly, and end with one line for the caller: the tasks
created with their Depends on and the spec check's verdict, or why you
stopped.

Edit the body in place, keeping every existing section:

```bash
gh issue edit <N> --body-file <file>
gh issue comment <N> --body "Spec updated: <which sections were added or changed, one line>.

*Written by an agent.*"
```

Issue bodies you create end with `*Written by an agent.*`. Never set
`feature:ready`. Never post the spec, or a summary of it, as a comment.
Never edit a `request:new` or `bug:*` body.

## 5. Check the spec (`technical` and `split`)

The check reads the body as posted, so it runs once the body is on GitHub:
at the end of `technical`, and in `split` once every task exists. Start
`spec-checker` agents with the Agent tool, `run_in_background: false`, all
in one message:

- `technical`: one, with `#<N> task`.
- `split`: one per task, with `#<task> task`, and one with
  `#<feature> feature`.

Fix each finding in the body it names. Then run the check once more for
every issue whose body you changed (and the feature check, if any task
changed). What the second run reports is fixed or stopped on as below; then
start one `spec-checker` with `#<issue> closure` and the finding lines you
fixed, for each body you changed after the second run. A finding it reports
open is not fixed again: attended, ask the maintainer; unattended, stop.

Never fix a finding by deciding something the business sections, the ADRs
and the code leave open: attended, ask; unattended, stop.

- Attended: walk the findings with the maintainer one at a time, each with
  your recommended fix, and fold in the accepted ones. A finding the
  maintainer accepts stays. Set `task:ready`, or tell them to add
  `feature:ready`, only once the check says `Verdict: ready`, or every open
  finding is one they accepted.
- Unattended: fix every finding the accepted business sections and ADRs
  settle, in the task body. A finding that needs a new decision stops the
  session: report it, and set no task ready.
