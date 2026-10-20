---
name: recurring-findings
description: Weekly routine — find the review-finding classes fixed in three or more PRs merged in the last four weeks, and open one draft task per class proposing the check or rule that would catch it before review. Use when a routine or the user says "recurring findings".
model: sonnet
effort: low
---

# Recurring findings

A defect that reviews keep finding is cheaper to catch with a script than
with a reviewer. You open draft tasks; you change no code and open no PR.
Call GitHub through `gh api` REST only: a cloud session refuses GraphQL.

## 1. Count

```bash
node .agents/scripts/recurring-findings.mjs > <scratch>/recurring.txt; echo "exit $?"
```

Each line after the first is a class fixed in three or more merged PRs.
None: report `Issues: none` and stop.

## 2. One draft task per class

For each class:

1. Skip it when an open issue's title already names it:
   `gh api -X GET search/issues -f q='repo:<owner>/<repo> is:issue is:open in:title "Recurring finding: <class>"' -q .total_count`.
2. Read each listed PR's `## Review ledger` comment and the fix commit of
   every finding of the class (`git show <fix>`): what the code was before
   the fix, and after.
3. Decide what would have caught it before review:
   - **a check**: a lint rule, a comment-lint case, a `stale-refs.sh`
     pattern or a new script, when the pre-fix code shows the defect
     without judgement. Name where it goes.
   - **a rule line**: one sentence for the review brief or rule file
     whose check missed it, when only judgement can see it.
4. Open the task:

   ```bash
   gh api -X POST repos/<owner>/<repo>/issues -f title="Recurring finding: <class>" \
     -F body=@<scratch>/<class>.md -f 'labels[]=task:draft' -q .number
   ```

   The body: the class and the PRs; for each finding its `path:line` and
   its pre-fix and fixed commits; the proposed check or rule line; and,
   for a check, one Done when line: it flags every pre-fix example above
   and passes every fixed one. End with `*Written by an agent.*`.

## Report

```
Routine: recurring-findings  Window: <from> to <to>  Classes: <n>
Issues: #a, #b | none
Skipped: <class> — <open issue> | none
```
