---
name: spec-session
description: Run a spec session on a GitHub issue — turn a request into a feature spec, write or amend its business section, add the technical section, or split it into task sub-issues; technical and split end with the spec-checker agent reading the posted body, and its findings are fixed before any approval box is ticked or ready label set. Always reconciles comments posted since the body was last edited before writing anything. Use when the user says "spec session for #N", "write the spec for #N", "add the technical spec to #N", or "split #N into tasks", and when the deliver skill specifies a feature:ready feature unattended.
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
answer. Use the technique of the `interview-me` and `grill-me` skills.

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
draft it in `docs/internal/adr/` at status _Proposed_ on a branch, with the
diagrams `docs/internal/adr/README.md` asks for, and add its line to
Decisions. Tell the maintainer the feature cannot leave `feature:spec` until
that ADR is accepted. Write only what
`docs/internal/agent-rules/always-in-scope.md` does not cover. End with the
spec check (step 5) on the posted body.

**`split`**: interview for the task list: vertical slices, each a PR one
agent can land, ordered so every task depends only on earlier ones. For each
task, write a body from `docs/internal/templates/task.md` with Scope,
Technical spec, Done when, Out of scope and Depends on filled in.

Write each body so the spec check finds nothing:

- no Done when line its own Tests or Scope make false, none a reviewer
  could not check, no failure mode left unanswered;
- two tasks that touch the same file, or overlap by a project check in
  `toolchain.md`, run one after the other: the later lists the earlier under
  Depends on;
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

Approval boxes:

- Attended: tick none. That is the maintainer's click, after the spec check.
- Unattended: `feature:ready` is the approval. Tick each box yourself once
  the spec check is done, in a second body edit after the task exists: the
  issue-state workflow promotes a task on body edits only, so a box ticked
  at creation leaves the task in `task:draft`.

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
at the end of `technical`, and in `split` once every task exists. Start the
`spec-checker` agent with the Agent tool, `run_in_background: false`, with
the issue number (the feature, for a split) as its prompt.

Fix each finding in the body it names. If you changed anything, run the
check once more. There is no third run: what the second run reports is
fixed or stopped on as below.

- Attended: walk the findings with the maintainer one at a time, each with
  your recommended fix, and fold in the accepted ones. A finding the
  maintainer accepts stays. Tell them to tick an approval box or add
  `feature:ready` only once the check says `Verdict: ready`, or every open
  finding is one they accepted.
- Unattended: fix every finding the accepted business sections and ADRs
  settle, in the task body. A finding that needs a new decision stops the
  session: report it, and tick no box.
