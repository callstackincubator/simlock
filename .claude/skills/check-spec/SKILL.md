---
name: check-spec
description: Check a feature or task spec as posted on GitHub, with a fresh context, before its approval box is ticked or its ready label is set — read the body, its parent or its tasks, the ADRs it names, the agent rules and the code it points at — and report contradictions, lines nobody could check, failure modes no line answers, overlapping tasks without a Depends on, and real-device lines with no slow-lane test, in a fixed block. Read-only. Use when spec-session reaches the end of technical or split mode, or when the user says "check the spec of #N".
model: opus
effort: high
context: fork
---

# Check a spec before it is ready

An agent will deliver this spec unattended and build exactly what the body
says (delivery rule 3). Every gap you find now is a parked run later. You
have not seen the session that wrote it, and that is the point: you read
the body as posted, not as its author meant it.

You are read-only. You edit no file, post nothing, and change no label. The
spec session fixes what you report.

Argument: an issue number. A task is checked with its parent. A feature
with sub-issues is checked as a whole: its body and every open sub-issue.

## 1. Read

```bash
gh issue view <N> --json number,title,labels,body
read -r OWNER REPO < <(gh repo view --json owner,name -q '"\(.owner.login) \(.name)"')
gh api graphql -F owner="$OWNER" -F repo="$REPO" -F number=<N> -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ issue(number:$number){
      parent{number body}
      subIssues(first:50){nodes{number title state body}}}}}'
```

Never the comment thread: the body is the spec. Then read only what the
spec must agree with:

- every file in `docs/internal/agent-rules/`. `always-in-scope.md` lists
  what every change includes without its spec asking, so a spec need not
  repeat it;
- `docs/internal/adr/README.md` and every ADR the spec names;
- `docs/internal/templates/feature.md` or `task.md`, whichever the body
  follows;
- the files and tests the Technical spec names, only to confirm what a line
  says: that a function exists, that a test asserts what the line says it
  does, that a grep finds what the line says it finds. Run the grep; do not
  read around.

Budget: about twenty file reads. A question you cannot settle within that
is a finding, not a reason to read more.

## 2. Check

Report a finding for each of these, and nothing else:

1. **contradiction.** A line that breaks an agent rule or an accepted ADR,
   or two lines that cannot both hold. A Done when line that the task's own
   Tests or Scope make false is one: "`routing.test.ts` is unchanged" next
   to a test that must assert a new payload field; "only added tests" next
   to a changed payload that existing `toEqual` assertions pin. Cite both
   lines.
2. **unverifiable.** A Done when line or Completion condition no reviewer
   could check from the diff, the suite, or a named command.
3. **failure-mode.** A way the change can fail that no line answers and no
   rule decides: a worker or daemon that does not answer, a restart midway,
   input out of bounds, an empty list, two callers at once, a wait with no
   budget (architecture rule 11), an exit that leaves a subject in no named
   state (architecture rule 12). A bound with no number is one.
4. **overlap.** Two tasks that touch the same file, or that both change a
   contract shape (each shape change bumps `DAEMON_PROTOCOL_VERSION` by
   one), with neither under the other's Depends on. Two agents
   editing the same lines in parallel is a merge conflict the second one
   resolves blind.
5. **hardware.** A Done when line that needs a real simulator or emulator
   but does not say so in its own words ("on a Mac with an iOS runtime:
   ..."), or does not name the slow-lane test that proves it.

What a rule, an accepted ADR or `always-in-scope.md` already answers is not
a gap. "Nothing shows the suite is green" is never a finding: CI proves it.
A finding counts only with the line it is about and what goes wrong because
of it. Do not rewrite the spec, propose features, or judge the idea.

## Report

End with exactly this block, nothing after it:

```
Issue: #N  Checked: <#N and each task read>  Findings: n
- [contradiction|unverifiable|failure-mode|overlap|hardware] #<issue> "<the line, quoted short>" — <what goes wrong>. Evidence: <file:line, rule or ADR number, or the command and its output>
Verdict: ready | fix first
```

With no findings, the middle lines are absent, `Findings: 0`, and the
verdict is `ready`.
