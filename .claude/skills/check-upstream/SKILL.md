---
name: check-upstream
description: Weekly routine — for every open issue labelled `upstream`, check whether the dependency issues or PRs its `## Waiting on upstream` comment links are fixed in a published release, and comment when they are. Use when a routine or the user says "check upstream".
model: sonnet
effort: low
---

# Check upstream

An `upstream` issue is `<kind>:blocked` on a fix in a dependency. You only
read and comment: you change no label but `upstream`, no code, and open no
PR (delivery rule 1: agents never label their way into work). Call GitHub
through `gh api` REST only: a cloud session refuses GraphQL.

## 1. List

```bash
gh api -X GET repos/<owner>/<repo>/issues -f labels=upstream -f state=open -f per_page=100 -q '.[].number'
```

None: report `Issues: none` and stop.

## 2. Each issue

1. Read its newest comment headed `## Waiting on upstream`. Each
   `Upstream:` line names one issue or PR (`<owner>/<repo>#<n>`) and the
   package it ships in. No such comment: list the issue under `Malformed`
   and go on.
2. For each link, read its state:
   `gh api repos/<owner>/<repo>/issues/<n> -q '{state,state_reason,closed_at,pull_request}'`.
   A closed issue: find the PR that closed it from its timeline
   (`gh api repos/<owner>/<repo>/issues/<n>/timeline`, a
   `cross-referenced` or `closed` event with a merged PR). A link is
   **fixed** when that PR is merged and the package's newest version
   (`pnpm view <package> version`; npm refuses this repo's `devEngines`)
   was published after the merge (that version's key in
   `pnpm view <package> time --json`). Closed as not planned is
   **refused**.
3. Every link fixed, or any refused: post one comment, unless a
   `## Upstream check` comment newer than the last `## Waiting on
   upstream` already says the same:

   ```markdown
   ## Upstream check

   - <owner>/<repo>#<n>: fixed in <package>@<version> (merged <date>) | refused: <reason, one line> | open
   - Pinned here: <package>@<the version in package.json>

   Next: bump <package> to <version>, then move this issue back to the label it came from. | Next: the maintainer decides how to go on without the fix.

   _Written by an agent._
   ```

   Then remove `upstream`:
   `gh api -X DELETE repos/<owner>/<repo>/issues/<N>/labels/upstream`.
   The `<kind>:blocked` label stays for the maintainer.

4. Otherwise post nothing: the issue is still blocked.

## Report

```
Routine: check-upstream  Issues: <n>
Unblocked: #a (<owner>/<repo>#<n> in <package>@<version>) | none
Refused: #b (<owner>/<repo>#<n>) | none
Still blocked: #c, #d | none
Malformed: #e | none
```
