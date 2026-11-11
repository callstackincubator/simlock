# Stage 5: tasks

The design is approved. A task adds nothing to it: it names the rows it
delivers and says how its PR is checked. The maintainer is asked again
only for a finding that needs a decision.

## Write

One body per task from `docs/internal/templates/task.md`, in dependency
order.

- Rows: every row whose Task cell names the task, and the Existing code
  rows it must handle.
- Tests: one line per Behaviours row of the task, starting with its id.
- Facts: only what no row of the parent holds. A command, flag, output
  shape or fixture a Tests line uses is run on `main`, or checked to
  exist, and cited.
- Depends on: the task of every Stored state or Interfaces row it uses;
  and a task, of this feature or another, that changes the same function
  or lines, or trips the same project check in `toolchain.md`. Tasks that
  only add to one file in different places run at once.
- Done when: lines a reviewer can check with the commands `toolchain.md`
  lets an agent run; one that needs the slow lane says so and names its
  test.
- Retired words: every word whose meaning the task ends.
- Nothing `always-in-scope.md` covers.

A detail you find missing while writing is a row of the parent: add it
there, and if it changes what a row says, send the diff to the design
checker (`recheck`) before going on.

## Post

```bash
gh issue create --title "<title>" --label task:draft --body-file <file>
gh api graphql -F parent="<feature node id>" -F child="<task node id>" -f query='
  mutation($parent:ID!,$child:ID!){
    addSubIssue(input:{issueId:$parent,subIssueId:$child}){ issue{number} }}'
```

Get a node id with `gh issue view <n> --json id -q .id`. Then replace each
`T<n>` in the feature by its issue number, fill its Tasks section, and
post it with a `Spec updated: ...` comment.

## Check

1. `node .agents/scripts/spec-lint.mjs <n>` on each task and
   `node .agents/scripts/spec-lint.mjs <feature> --feature`. Fix every `B`
   line.
2. One `spec-checker` with `#<feature> tasks`. Fix each blocking finding
   in the body it names; a design detail goes into the parent's row. Send
   the diff back as `recheck`, once more after a second fix.
3. A finding marked `Decision: yes`, or one still open after two fixes,
   goes to the maintainer in one round.

## Set ready

When the lint is clean and the check says `Verdict: ready` or the
maintainer accepted what is left:

```bash
gh issue edit <task> --add-label task:ready --remove-label task:draft
gh issue edit <feature> --add-label feature:planned --remove-label feature:spec
```

End with the task table (number, what it delivers, Depends on), the chain
line of `node .agents/scripts/runnable.mjs <feature>`, and every decision
taken since the approval.
