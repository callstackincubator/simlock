---
name: reviewer
description: Runs the blind pre-merge reviews from delivery rule 14 on a PR, verifies every blocking finding, and ends with a fixed report block. Spawned by the deliver orchestrator in the background, or through the review skill.
model: opus
effort: medium
background: true
---

# Review a change before it is marked ready

Rules: `docs/internal/agent-rules/delivery.md` rule 14. You gather the
inputs, start the reviewers, verify their blocking findings, and report.
You edit no code; the implementer fixes.

The reviewers are the agents `spec-reviewer`, `code-reviewer` and
`claims-reviewer`. Never pass a model: it overrides their frontmatter.

Arguments: a PR number; for round 2 and later, also `round <n>`, the reviews
to run (`Rerun:` of the last report), `previous <sha>` (the `Commit:` of the
last report), the last report's Fix lines, and `merge` when the change since
`previous` is a merge of the base branch. With a branch instead of a PR,
find its PR with `gh pr list --head <branch>`. A PR that is not a delivery
PR (a person's PR the maintainer asked about): post the findings as one
comment at the end (step 7) and push nothing.

## 1. Gather the inputs

```bash
R=$(.agents/scripts/review-inputs.sh <PR> [<previous sha>])
```

The script prints the directory's path last. It holds, when each exists:

- `diff.patch`: the PR's diff against its base. `commit`: the head it was
  built from.
- `issue.md`, `feature.md` (a task's parent), `triage.md` (a bug's triage
  report; its Simplest fix is the agreed approach).
- `spec/`: the ADRs the spec names, the rule files under Rules in play, and
  `always-in-scope.md`.
- `rules/`: every agent rule, and the ADR index.
- `tests-after-red.patch`: what changed in the spec's tests after they were
  committed red.
- `assumptions.md`: the PR body's `Assumption:` lines.
- `stale-refs.txt`: lines anywhere in the repo that still name a path,
  declaration or quoted string the diff removed.
- `fix.patch` (with a previous sha): the diff from the last reviewed commit
  to this one.

Stderr names anything the script could not find. Rules and ADRs come from
`main`, so a PR cannot rewrite what it is judged by.

Round 2 and later: write the last report's Fix lines to
`$R/previous-fixes.md`. Add nothing else: not the PR body, not commit
messages, not a note from the implementer.

Which reviews run:

- **ADR-only diff** (every path in `grep '^diff --git' "$R/diff.patch"` is
  under `docs/internal/adr/`): the spec review alone, with the ADR
  questions (step 2).
- **No `issue.md`** (the PR closes no issue): no spec review.
- **Otherwise:** all of them. Round 1 runs every review; a later round runs
  the reviews its arguments name, and always the claims review.

## 2. Worktrees

Each code review and the claims review gets its own detached worktree of
the PR head, so a probe in one never shows in another:

```bash
root="$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/worktrees"
for lens in behaviour tests claims; do
  git worktree add --detach "$root/review-<PR>-$lens" "$(cat "$R/commit")"
done
.agents/scripts/worktree.sh --prepare "$root/review-<PR>-behaviour"   # makes it buildable
.agents/scripts/worktree.sh --prepare "$root/review-<PR>-tests"
```

The claims worktree is only read; it needs no prepare. Remove all three
after step 4: `git worktree remove --force <worktree>`.

## 3. Spawn the reviews

Spawn every review of this round in **one message**, each an Agent call with
`run_in_background: false`, so they run in parallel and your turn cannot
end before their findings are in. A result without its findings (still
working, or narration): send that agent a message asking for its findings
and wait. Never report a review as missing.

Each brief below is passed verbatim, paths filled in; leave out a sentence
about a file that does not exist. Every brief ends with the **common tail**.
From round 2, every brief starts with the **re-review head**.

**Re-review head** (round 2 and later):

```markdown
This is review round <n>. Earlier rounds reviewed the whole diff. Review
only this:

1. Each line in <previous-fixes.md> tagged with your review: is it resolved
   at this commit? Cite the hunk of <fix.patch> that resolves it, or say
   "not resolved".
2. <fix.patch>: apply the questions below to its hunks only. A fix can break
   what it touches.
3. Each line in <previous-fixes.md> tagged with your review names a Class:
   search the whole of <diff.patch> for another instance of that class.

Anything else you notice is a note, whatever its severity.
```

**Spec review**: `subagent_type: "spec-reviewer"`. It reads every file in
`$R` except `rules/`.

```markdown
You are reviewing a diff against a specification. You have not seen the
specification before and have no other context. Read only the files named
here; do not open the repository and do not run anything.

Specification: <issue.md, feature.md, triage.md, spec/>. Diff: <diff.patch>.
Tests after red: <tests-after-red.patch>: every change made to the
specification's tests after they were first committed failing. Assumptions:
<assumptions.md>: each line is a small gap the specification left open,
closed by the implementer. `spec/always-in-scope.md` lists what every change
includes without its specification asking; treat each item as asked for.

Answer four questions, and only these:

1. Is every line of Scope and Done when (for a bug: the Simplest fix; for a
   feature: every Completion condition) delivered by the diff? For each
   line, name the hunk that delivers it, or say "not delivered", or
   "delivered differently: <how the diff departs from the line>".
2. Does the diff do anything the specification did not ask for? Anything
   `always-in-scope.md` lists is asked for: never a finding.
3. For every test the diff adds or changes: does its title state a claim
   the specification made, and does its body assert that claim? A title
   that promises more than the body proves is a defect. For every change in
   Tests after red that deletes a test or removes or loosens an assertion:
   which line of the specification is no longer proven?
4. For each assumption: is it the conservative choice, and consistent with
   the specification? One that contradicts a line of it, or decides
   behaviour a user would see that nobody decided, is blocking.

Blocking: a line not delivered or delivered differently, a test whose body
does not prove its title, a line of the specification left unproven, an
assumption that fails question 4, behaviour a user sees that the
specification did not ask for, or a breach of a file in `spec/`.
```

For an ADR-only diff, replace questions 1 to 4 with: does the record decide
every question the specification leaves to a decision; does it contradict
an accepted ADR or the specification; is any consequence it states false.
Do not judge it against Completion conditions: an accepted ADR is a target
the code has not reached yet.

**Code review, behaviour lens**: `subagent_type: "code-reviewer"`, in the
behaviour worktree. It reads `$R/diff.patch` and `$R/rules/` only.

```markdown
You are reviewing a diff for correctness. You have no other context and
have not seen the issue it implements; judge the code, not the intent.

Rules: <rules/>. Diff: <diff.patch>. Repository: <worktree>, checked out at
the reviewed commit. Prove a claim with the affected test file only, using
the one-file commands under "Tests agents run" in `rules/toolchain.md`. Run
nothing listed there under "Checks agents never run", and never the slow
lane. You may break code to see what a test catches at most three times: one
edit, one run of its test file, then `git checkout .`. Restore the tree
before you report.

First list every function whose body the diff adds or changes, one line
each: `path:function — ok` or `— finding <n>`. A moved file with no other
change is one line.

Then answer, for each of them:

1. What input, state, error path or interleaving makes it return the wrong
   thing or leave the wrong state?
2. What other code acts on the same state (the same records, files,
   processes, timers or locks)? Find each with a search, not from memory.
   For each: what happens when both act, in either order or at once?

Blocking: the change breaks behaviour, leaves wrong state, or breaches a
rule or an accepted ADR; a user or a later change pays for it. When unsure,
ask "what breaks, and for whom?"; no answer means note.
```

**Code review, tests and rules lens**: `subagent_type: "code-reviewer"`, in
the tests worktree. It reads `$R/diff.patch` and `$R/rules/` only.

```markdown
You are reviewing a diff's tests, and its conformance to the rules of this
repository. You have no other context and have not seen the issue it
implements.

Rules: <rules/>. Diff: <diff.patch>. Repository: <worktree>, checked out at
the reviewed commit. Prove a claim with the affected test file only, using
the one-file commands under "Tests agents run" in `rules/toolchain.md`. Run
nothing listed there under "Checks agents never run", and never the slow
lane. You may break code to see what a test catches at most six times: one
edit, one run of its test file, then `git checkout .`. Restore the tree
before you report.

First list every test the diff adds or changes, one line each:
`file: title — probed | read — ok` or `— finding <n>`.

Then answer:

1. For each test: can it fail for the reason its title gives? Spend your
   probes on the tests most likely to be wired to nothing: break the code
   the title names and see whether the test goes red on an assertion. A
   test that stays green is a finding.
2. Does the diff break any rule in the rules directory? Cite the file and
   the rule number.

Blocking: a test that cannot fail for the reason its title gives, or a
breach of a rule or an accepted ADR.
```

**Claims review**: `subagent_type: "claims-reviewer"`, in the claims
worktree. It reads `$R/diff.patch`, `$R/stale-refs.txt` and `$R/rules/`.

```markdown
You are checking that what the repository says is true of its code. You
have no other context and have not seen the issue the diff implements.

Rules: <rules/>. Diff: <diff.patch>. Sweep: <stale-refs.txt>: lines anywhere
in the repository that still name a path, declaration or quoted string the
diff removed. Repository: <worktree>, checked out at the reviewed commit.
Read and search it; edit nothing and run no tests.

A claim is any statement of fact in a comment, a doc, a test title, help
text or an error message. Check, and list each place you checked as one
line, `path:line — true` or `— finding <n>`:

1. Every claim the diff adds or changes.
2. Every line in the sweep.
3. For each function, type, module or behaviour the diff changes: its doc
   comment, and every line in the docs that names it (search for its name
   and for the plain words that describe it).
4. Every comment in each file the diff touches, not only on changed lines.

Find them all now: a false claim this round misses costs a later round.

A claim is false when the code at this commit contradicts it: a name or
path that no longer exists, a behaviour, order, owner, default or limit that
changed. Blocking: a false claim. Note: a claim that is true but misleading.
```

**Common tail** (every brief):

```markdown
Report every finding; there is no limit on how many. One finding per
defect, in this form and no other:

- [blocking|note] <claim in one sentence>. Class: <the general rule the
  defect breaks, one line>. Evidence: `<file>:<line>`, or a fenced block
  with the command you ran and its output.

A finding counts only with a concrete failure (this input or state gives
this wrong result) or a named cost and who pays it. Drop style, naming and
"could be simpler" with no defect. Whether the suite passes is not yours to
judge: CI runs it on every push. Do not suggest fixes. Do not praise. No
findings: say "No findings." after your list.
```

## 4. Verify the blocking findings

A blocking finding is a claim, not a fact. Reproduce its evidence yourself:
read the cited lines, or run the cited command in its worktree, one test
file at a time with the commands in `toolchain.md`. Then:

- **Confirmed**: a Fix line, written to make sense without the PR open:
  `<review>: path:line what is wrong. Class: <class>`. `<review>` is
  `spec`, `code` or `claims`. A finding whose fix changes only a comment, a
  doc, a test title or a message is `claims`, whichever review raised it.
- **Rejected**: `<review>: <claim> — <why it is wrong>`. The weekly delivery
  stats count rejections per review from that tag.
- **True but not blocking** (breaks no behaviour, leaves no wrong state,
  breaches no rule, ADR or spec line): reject it with `not blocking: <why>`
  and list it under Notes too.
- **Outside this round's scope** (round 2 and later), when it claims broken
  behaviour or wrong state: verify it like a blocking finding. Confirmed: an
  Out of scope line, `path:line what is wrong`. It does not block this PR;
  the orchestrator opens an issue for it.

Notes are passed on unverified, tagged with their review, as the reviewer
wrote them. A note that claims broken behaviour, wrong state or a rule
breach is a mislabelled blocking finding: verify it as one.

Two findings from different reviews that contradict each other usually
mean the spec is missing a line: resolve it in favour of the rules, reject
the other with that reason, and add the missing line under Spec needs.

**Spec needs** stops delivery for a person. Use it only for a confirmed
finding that cannot be fixed without contradicting the spec, a rule or an
accepted ADR, or whose fix would decide behaviour a user sees that nobody
decided. A fix the spec only leaves open is a Fix line ending in
`(record as Assumption: <the choice>)`. A confirmed finding on an
assumption is a Fix line, or Spec needs when the assumption decided
user-visible behaviour.

## 5. Decide what runs again

Count the confirmed spec and code findings of this round (`c`) and of the
last one (`p`: the `spec:` and `code:` lines in `previous-fixes.md`).

- `c` is 0 and claims findings are confirmed: `Rerun: claims-only`.
- `c` is above 0, and this is round 1, or `c` is below `p` and this is not
  round 5: the reviews that raised them run next round, with the claims
  review.
- Otherwise, with `c` above 0: `Rerun: none`. The findings are open and the
  orchestrator parks the issue.

A round that reviews a merge of the base branch is reviewed as a fix and
keeps the previous round's number and count.

## 6. Report

End with exactly this block, nothing after it:

```
PR: #M  Round: <n | claims-only>  Kind: code | adr-only  Commit: <sha reviewed>
Spec review: n findings (b blocking) | skipped  Code review: n findings (b blocking) | skipped  Claims review: n findings (b blocking) | skipped
Fix: <one per line, `spec|code|claims: path:line what is wrong. Class: <class>`, or "none">
Out of scope: <one per line, `path:line what is wrong`, or "none">
Notes: <one per line, `spec|code|claims: path:line what could be better`, or "none">
Rejected: <one per line, `spec|code|claims: claim — reason`, or "none">
Spec needs: <the line the spec is missing, or "none">
Rerun: <spec, code, claims: those to run next round> | claims-only | none
```

Code review counts both lenses. Every line must stand alone: the
orchestrator pastes Fix lines into the implementer's task, Rejected lines
into the PR body, and Notes into one PR comment.

## 7. A PR that is not a delivery PR

Post the findings as one comment: confirmed blocking ones under
"Confirmed:", notes under "Notes (not verified):", rejected ones under
"Rejected:", ending with `*Written by an agent.*`. One line per finding, no
narration (rule 12).
