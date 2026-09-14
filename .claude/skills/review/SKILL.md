---
name: review
description: Run the two pre-PR reviews from delivery rule 14 on a branch or an open PR — a spec review blind to the rules and a code review blind to the issue, each by a fresh sub-agent — then verify every finding, fix or reject each, and write the Review section for the PR body. Use when the user says "review #N", "review this branch", "review PR N", or from the deliver skill before opening a PR.
---

# Review a change before its PR

Rule 14 in `docs/internal/agent-rules/delivery.md` governs this skill: two
reviews, each blind to the other and to you; every finding verified, then
fixed or rejected with a reason; two rounds at most. Rule 12 governs
everything you write.

Argument: an issue number, a PR number, or nothing. With nothing, review the
current branch; the issue is the second segment of its `<kind>/<n>` name.
With a PR number, the branch is the PR's head and the issue is the one its
body closes. If the PR is not yours, do not push to it: run steps 1 to 4 and
post the confirmed findings as one comment (step 6).

## 1. Gather the inputs

Every input goes into a directory the reviewers read from, so what they see
is exactly what you put there and nothing else.

```bash
git fetch origin main
R=$(mktemp -d)
git diff origin/main...HEAD > "$R/diff.patch"
gh issue view <N> --json body -q .body > "$R/issue.md"
```

For a task, add the parent's body as `$R/feature.md`. Copy every ADR listed
under Decisions and every file listed under Rules in play into `$R/spec/`.
For a bug, add the triage report as `$R/triage.md`; the Simplest fix section
is the agreed approach. Copy all of `docs/internal/agent-rules/` and
`docs/internal/adr/README.md` into `$R/rules/`.

Do not add the PR body, your commit messages, your handoff draft, or any
note from this session. The reviewers must not know what you believe the
diff does.

## 2. Spawn the spec review

A fresh sub-agent on the most capable model available, never a smaller one
chosen for speed. Read-only: it reads `$R/diff.patch`, `$R/issue.md`,
`$R/feature.md`, `$R/triage.md` and `$R/spec/`, and nothing under
`$R/rules/`. Give it this brief, verbatim, with the paths filled in:

```markdown
You are reviewing a diff against a specification. You have not seen the
specification before and you have no other context. Read only the files
named here; do not open the repository and do not run anything.

Specification: <paths>. Diff: <path>.

Answer three questions, and only these:

1. Is every line of Scope and Done when (for a bug: the Simplest fix; for a
   feature: every Completion condition) delivered by the diff? For each
   line, name the hunk that delivers it or say "not delivered".
2. Does the diff do anything the specification did not ask for? Name it.
3. For every test the diff adds or changes: does the title state a claim
   the specification made, and does the body assert that claim? A title
   that promises more than the body proves is a defect.

Report one finding per defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Evidence: `<file>:<line>`.

Blocking means the PR should not merge as is. Note means a reviewer should
know. Do not suggest fixes. Do not praise. If there are no findings, say
"No findings." and stop.
```

## 3. Spawn the code review

In parallel with step 2. A fresh sub-agent on the same class of model, in
its own worktree of the branch under review, so it can run and break things
without touching yours. It reads `$R/diff.patch` and `$R/rules/`, and
nothing else under `$R`. Give it this brief, verbatim:

```markdown
You are reviewing a diff for correctness and for conformance to the rules
of this repository. You have no other context and you have not seen the
issue this diff implements; judge the code, not the intent.

Rules: <path to $R/rules/>. Diff: <path>. Repository: your working
directory, checked out at the reviewed commit. You may run `pnpm check`,
`pnpm test`, and any command that helps you answer; you may edit code to
see what the suite catches, as long as `git checkout .` restores it before
you report.

Answer two questions, in this order:

1. For every function the diff adds or changes: what input, state, error
   path, or interleaving makes it return the wrong thing or leave the
   wrong state? Where a test exists for it, break the code it covers and
   run the test; if the test stays green, that is a finding. Where you
   suspect a changed path is unreached by any test, delete it and run the
   suite; if nothing goes red, that is a finding.
2. Does the diff break any rule in the rules directory? Cite the file and
   the rule number.

Report one finding per defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Evidence: `<file>:<line>`, or a
  fenced block with the command you ran and its output.

Blocking means the PR should not merge as is. Note means a reviewer should
know. Do not suggest fixes. Do not praise. If there are no findings, say
"No findings." and stop.
```

## 4. Verify every finding

A finding is a claim, not a fact. For each one, reproduce its evidence
yourself: read the cited lines, or run the cited command. Then decide:

- **Confirmed**: fix it on the branch. Do not note it anywhere; the diff is
  the record.
- **Rejected**: write one line for the PR body, `<claim> — <why it is
wrong>`, in plain words.

Two findings that disagree with each other, one from each review, usually
mean the spec is missing a line. Resolve it in favour of the rules, reject
the other with that reason, and say "spec needs: ..." in the PR body.

## 5. Second round

If any confirmed finding changed the diff, regenerate `$R/diff.patch` and
run again only the review whose findings you fixed, with a fresh sub-agent.
Verify as in step 4. That is the last round.

A blocking finding still open after the second round, one you could neither
fix nor reject with a reason, means the change is contested. Do not open
the PR. Push the branch, hand off with the finding under Findings (deliver
skill, step 6), and stop.

## 6. Write the Review section

Into the PR body, after the checklist:

```markdown
## Review

Spec review: <n> findings, <m> fixed. Code review: <n> findings, <m> fixed.

Rejected:

- <claim> — <reason>
```

Omit "Rejected:" when nothing was. This section is outside the 200-word
budget, like the checklist, and it still obeys rule 12: one line per
rejected finding, no narration of what was fixed.

On a PR that is not yours, post the same text as one comment instead, with
the confirmed findings listed under "Confirmed:" since nobody has fixed
them, ending with `*Written by an agent.*`.
