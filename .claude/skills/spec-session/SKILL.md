---
name: spec-session
description: Run a spec session on a GitHub issue — turn a request into a feature spec, write or amend its business section, add the technical section, or split it into task sub-issues; technical and split end with the forked check-spec skill reading the posted body, and its findings are fixed before any approval box is ticked or ready label set. Always reconciles comments posted since the body was last edited before writing anything. Use when the user says "spec session for #N", "write the spec for #N", "add the technical spec to #N", or "split #N into tasks", and when the deliver skill specifies a feature:ready feature unattended.
---

# Spec session

You are writing the body of a `feature:*` or `task:*` issue on behalf of the
maintainer. The rules in `docs/internal/agent-rules/delivery.md` are binding; the ones
that matter most here are 3 (the body is the spec), 4 (reconcile first), 5
(never rewrite a reporter's issue), 6 (outcomes, not implementation) and 7
(a task carries both halves, and is checked before it is ready).

Argument: an issue number, optionally followed by a mode: `business`,
`technical`, `split`, or `revise`, and optionally `unattended`. Without a
mode, infer it from the state of the body and confirm with the user before
writing.

**Unattended** is only for `split` on a `feature:ready` feature, run by the
`deliver` skill. The maintainer's `feature:ready` already accepted the
business sections and every linked ADR (delivery rule 1), so nobody is
asked anything. Where an attended session would ask, decide from the
business sections, the ADRs and the codebase. Stop instead, and report why,
when:

- reconciling finds a comment that would change the spec: the maintainer
  must accept it first;
- a decision needs a new ADR (constrains more than one task, or is
  expensive to reverse): the maintainer must accept it first;
- a question only the maintainer can answer remains, including a spec
  check finding (step 5) the accepted business sections do not settle.

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
Unattended, any item stops the session (see above).
Accepted items are folded into the relevant section when you write the body
in step 4. Do not proceed to step 3 until every item has an answer.

## 3. Do the session

Every mode is an interview, one question at a time, with your recommended
answer attached to each question. Explore the codebase instead of asking
whenever the codebase can answer. The `interview-me` and `grill-me` skills
describe the technique; use it.

**Creating a feature from a request** (`request:new` issue given):
interview for the business sections of `docs/internal/templates/feature.md`, then

```bash
gh issue create --title "<title>" --label feature:spec --body-file <file>
gh issue comment <request> --body "Being specified in #<new>. This issue stays open until that feature ships.

*Written by an agent.*"
```

The new body's first line is `Request: #<request>`.

**`business`**: write or amend the sections Problem through Open questions.
Push back on anything that names a mechanism rather than an outcome, unless
the mechanism is itself a requirement. Leave Open questions non-empty if
questions remain; the feature does not leave `feature:spec` until it is empty.

**`technical`** (feature delivered as one PR): fill the Technical spec
section. Before writing it, ask whether any decision here constrains more
than one future change or would be expensive to reverse. Each such decision
becomes an ADR: draft it in `docs/internal/adr/` at status _Proposed_ on a branch, and
add its line to Decisions. Tell the maintainer the feature cannot leave
`feature:spec` until that ADR is accepted. Write only what
`docs/internal/agent-rules/always-in-scope.md` does not already cover. The
session ends with the spec check (step 5) on the posted body.

**`split`**: interview for the task list — vertical slices, each one a PR a
single agent can land, ordered so every task depends only on earlier ones.
For each task, write a body from `docs/internal/templates/task.md` with Scope,
Technical spec, Done when, Out of scope and Depends on filled in.

Write each body so the spec check finds nothing: no Done when line its own
Tests or Scope make false, none a reviewer could not check, no failure mode
left unanswered; two tasks that touch the same file or both change a
contract shape run one after the other, the later one listing the earlier
under Depends on; a Done when line that needs a real simulator or emulator
says so in its own words ("on a Mac with an iOS runtime: ...") and names
the slow-lane test that proves it. Do not repeat what `always-in-scope.md`
covers.

Then create each task:

```bash
gh issue create --title "<title>" --label task:draft --body-file <file>
gh api graphql -F parent="<feature node id>" -F child="<task node id>" -f query='
  mutation($parent:ID!,$child:ID!){
    addSubIssue(input:{issueId:$parent,subIssueId:$child}){ issue{number} }}'
```

Get a node id with `gh issue view <n> --json id -q .id`. Run the spec check
(step 5) on the feature, which reads every task you created. Then remove the
Technical spec section from the feature body, add a Tasks section listing the
sub-issues in order, and change the label:

```bash
gh issue edit <feature> --add-label feature:planned --remove-label feature:spec
```

Unattended, the feature comes from `feature:ready`; remove that label
instead of `feature:spec`.

Attended, do not tick any task's approval box: that is the maintainer's
click, after the spec check. Unattended, the feature's `feature:ready` is
the approval, so tick each box yourself once the spec check is done, in a
second body edit after the task exists: the issue-state workflow promotes a
task on body edits only, so a box ticked at creation would leave the task
in `task:draft`.

**`revise`**: only the reconcile step plus whatever amendments it produced.

Write the spec the way rule 12 asks for everything else: short sentences,
common words, one idea per sentence. A spec is read by an agent that will
build exactly what it says, so every sentence that does not constrain the
build is a sentence to cut.

## 4. Write back and leave a marker

If a person is present in this session, show the new body first and wait for a
yes before posting. Running unattended, post directly, and end with one line
for the caller: the tasks created with their Depends on and the spec check's
verdict, or why you stopped.

Edit the body in place, keeping every section that already existed:

```bash
gh issue edit <N> --body-file <file>
gh issue comment <N> --body "Spec updated: <which sections were added or changed, one line>.

*Written by an agent.*"
```

Issue bodies you create end with `*Written by an agent.*` too; the spec
sections above it are what the maintainer approved, the line just says who
typed them. Never set `feature:ready`. Never post the spec, or a summary of it, as a
comment. Never edit a `request:new` or `bug:*` body.

## 5. Check the spec (`technical` and `split`)

The spec check reads the body as posted, so it runs after the body is on
GitHub: at the end of `technical`, and in `split` once every task exists.
Invoke the `check-spec` skill with the issue number (the feature, for a
split). It is forked: it reads with a fresh context and hands back only its
report block.

Fix each finding in the body it names, then run the check once more if you
changed anything. Attended, walk the findings with the maintainer one at a
time, each with your recommended fix, and fold in the accepted ones. A
finding the maintainer decides to accept stays as it is. Tell the
maintainer to tick an approval box or add `feature:ready` only once the
check says `Verdict: ready`, or every open finding is one they accepted.

Unattended, fix every finding the accepted business sections and ADRs
settle, in the task body. A finding that needs a new decision stops the
session (see the top): report it, and tick no box.
