---
name: spec-session
description: Run a spec session on an issue with the maintainer — explore, interview, write the design and check it against the code, get one approval, then write the tasks and set them ready. Use when the user says "spec session for #N", "spec #N", "split #N into tasks" or "revise the spec of #N".
model: opus
effort: medium
---

# Spec session

You turn a request into a feature and its tasks, with the maintainer, in
one session. Rules: `docs/internal/agent-rules/delivery.md` 3 to 7.

Five stages, in order. Start a stage only when the one before it is done,
and read its file when it starts, not earlier.

| Stage        | Read                           | Done when                                                                              |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------- |
| 1. Load      | below                          | the issue, its request and the comments after its last edit are read                   |
| 2. Explore   | `docs/internal/EXPLORATION.md` | today's flow is drawn from lines you opened                                            |
| 3. Interview | `interview.md`                 | no decision is open, and every claim about today has a source                          |
| 4. Design    | `design.md`                    | the feature is posted, the lint and the design check pass, and the maintainer approved |
| 5. Tasks     | `tasks.md`                     | every task is `task:ready` and the feature `feature:planned`                           |

Two rules hold in every stage:

- **One home for each fact.** A design fact is written once, in the
  feature row that owns it. An ADR holds the decision and its reasons; a
  task names row ids. To change a fact, change its row.
- **Nothing is guessed.** What source can answer, you read. What only the
  maintainer can decide and is expensive to reverse, changes scope, or
  changes what a user sees, you ask. The rest you decide, and list under
  the feature's Decisions as `Decided in the session: <what>, because
  <why>`, so the approval covers it.

Argument: an issue number, optionally `revise`.

- A `request:new` issue: create the feature from it (stage 1), then run
  the whole session on the feature.
- A `feature:spec` feature: the whole session. Its Open questions are
  where it starts.
- A `task:draft` task: load its feature, explore only what the task
  touches, settle its open choices, then stage 5 for that task. The
  feature becomes `feature:planned` only when all its tasks are ready.
- `revise`, on a feature or a task: reconcile (stage 1), then interview
  only for the amendments. A changed row goes through the design check
  again before any task that names it is touched.

An issue written before the design tables (a feature with `## Shared
values`, a task with `## In short`) is moved to today's templates when a
session takes it up: each design fact goes to a row of the feature, which
passes stage 4 before its tasks are rewritten.

A person is always present. Nothing runs this skill unattended.

## 1. Load

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

Refuse a `bug:*` issue: its body belongs to the reporter. A `Request: #M`
line in the body: load issue M the same way; its comments are part of the
discussion.

**Reconcile.** For every comment on the issue and its request created
after `lastEditedAt` (or `createdAt`), decide whether it changes the spec.
List one item per proposed change: the comment's author and URL, and the
section it touches. Ask the maintainer to accept or reject each, in the
first interview round.

**A `request:new` issue.** Write a stub feature: `Request: #<request>` as
its first line, the Problem in the reporter's words.

```bash
gh issue create --title "<title>" --label feature:spec --body-file <file>
gh issue comment <request> --body-file <file holding: Being specified in #<new>. This issue stays open until that feature ships.>
```

Bodies and comments you write end with `*Written by an agent.*`. Never
edit a `request:new` or `bug:*` body, or the body of another feature or
its tasks.

## 2. Explore

Before the first question, map the code, the docs and ADRs, and the open
work the request touches. Search directly for a known symbol; start
`spec-explorer` helpers together for broader independent areas, each with
`issue`, `request`, `area`, the commit and concrete `questions`.

1. Open every line an explorer cites. Keep a fact only when the line
   bears it out.
2. Check each contradiction and conflict against its sources; drop the
   ones that do not hold. One that a rule, an accepted ADR or the code's
   handling of the same case does not settle is a question for the first
   round.
3. Draw today's flow as the user sees it: a Mermaid diagram of at most
   ten boxes.

## Stopping part way

The maintainer may stop the session. Write the feature as far as it is
settled, with every open decision under Open questions. The feature stays
`feature:spec`; the next session starts there.

## Writing for the maintainer

Short sentences, a user's words. Explain a term from the code, an ADR or a
rule the first time, with an example, and add it to Words used. Say the
reason, never a rule or ADR number. A rule that accepts, rejects or
matches input gets a table of example inputs, odd cases included, with
today's result (run the tool on `main`) beside the proposed one.
