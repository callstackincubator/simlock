---
name: spec-session
description: Run a spec session on a GitHub issue — turn a request into a feature spec, write or amend its business section, add the technical section, or split it into task sub-issues. Always reconciles comments posted since the body was last edited before writing anything. Use when the user says "spec session for #N", "write the spec for #N", "add the technical spec to #N", or "split #N into tasks".
---

# Spec session

You are writing the body of a `feature:*` or `task:*` issue on behalf of the
maintainer. The rules in `docs/agent-rules/delivery.md` are binding; the ones
that matter most here are 3 (the body is the spec), 4 (reconcile first), 5
(never rewrite a reporter's issue) and 6 (outcomes, not implementation).

Argument: an issue number, optionally followed by a mode: `business`,
`technical`, `split`, or `revise`. Without a mode, infer it from the state
of the body and confirm with the user before writing.

## 1. Load the issue

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

Refuse to continue if the issue's label is `bug:*` or if it is `request:new`
and the mode is anything other than creating a feature from it: those bodies
belong to the reporter.

If the body has a `Request: #M` line, load issue M the same way; its comments
are part of the discussion.

## 2. Reconcile

The cut-off is `lastEditedAt`, or `createdAt` if the body was never edited.
Take every comment on the issue and on its linked request created after the
cut-off. For each one decide whether it changes the spec. Present the result
as a list, one item per proposed change, each naming the comment's author and
URL and the section it touches. Comments that change nothing are not listed.

Ask the maintainer to accept or reject each item, one question at a time.
Accepted items are folded into the relevant section when you write the body
in step 4. Do not proceed to step 3 until every item has an answer.

## 3. Do the session

Every mode is an interview, one question at a time, with your recommended
answer attached to each question. Explore the codebase instead of asking
whenever the codebase can answer. The `interview-me` and `grill-me` skills
describe the technique; use it.

**Creating a feature from a request** (`request:new` issue given):
interview for the business sections of `docs/templates/feature.md`, then

```bash
gh issue create --title "<title>" --label feature:spec --body-file <file>
gh issue comment <request> --body "Being specified in #<new>. This issue stays open until that feature ships."
```

The new body's first line is `Request: #<request>`.

**`business`**: write or amend the sections Problem through Open questions.
Push back on anything that names a mechanism rather than an outcome, unless
the mechanism is itself a requirement. Leave Open questions non-empty if
questions remain; the feature does not leave `feature:spec` until it is empty.

**`technical`** (feature delivered as one PR): fill the Technical spec
section. Before writing it, ask whether any decision here constrains more
than one future change or would be expensive to reverse. Each such decision
becomes an ADR: draft it in `docs/adr/` at status _Proposed_ on a branch, and
add its line to Decisions. Tell the maintainer the feature cannot leave
`feature:spec` until that ADR is accepted.

**`split`**: interview for the task list — vertical slices, each one a PR a
single agent can land, ordered so every task depends only on earlier ones.
For each task, write a body from `docs/templates/task.md` with Scope,
Technical spec, Done when, Out of scope and Depends on filled in, then:

```bash
gh issue create --title "<title>" --label task:draft --body-file <file>
gh api graphql -F parent="<feature node id>" -F child="<task node id>" -f query='
  mutation($parent:ID!,$child:ID!){
    addSubIssue(input:{issueId:$parent,subIssueId:$child}){ issue{number} }}'
```

Get a node id with `gh issue view <n> --json id -q .id`. Then remove the
Technical spec section from the feature body, add a Tasks section listing the
sub-issues in order, and change the label:

```bash
gh issue edit <feature> --add-label feature:planned --remove-label feature:spec
```

Do not tick any task's approval box. That is the maintainer's click.

**`revise`**: only the reconcile step plus whatever amendments it produced.

## 4. Write back and leave a marker

Edit the body in place, keeping every section that already existed:

```bash
gh issue edit <N> --body-file <file>
gh issue comment <N> --body "Spec updated: <which sections were added or changed, one line>."
```

Never set `feature:ready`. Never post the spec, or a summary of it, as a
comment. Never edit a `request:new` or `bug:*` body.
