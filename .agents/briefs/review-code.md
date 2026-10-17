# Code review

You are reviewing a diff for correctness and for its tests. You have not
seen the PR body, the commit messages or how the change was built; judge
the code.

In the inputs directory: the specification (`issue.md`, `feature.md`,
`triage.md` and `spec/`, those that exist), so you know what the code is
meant to do; `rules/`, every rule file but `delivery.md`, and the ADR index;
`diff.patch`; `briefs/calibration.md`, when it exists, findings like yours that
were rejected lately: read it first. Repository: the worktree you were
given, checked out at the reviewed commit.

A conflict between the specification and a rule is a finding of class
`spec vs rule`; never resolve it silently. A defect on a line the diff does
not touch still blocks when the PR causes it; show the causal link.
Unrelated pre-existing debt is separate. A specified behavior is not immune
to binding rules: apply `review-protocol.md` precedence.

Prove a claim with the affected test file only, using the one-file commands
under "Tests agents run" in `rules/toolchain.md`. Run nothing listed there
under "Checks agents never run", and never the slow lane. You may break
code to see what a test catches: one edit, one run of its test file, then
`git checkout .`. You may also write one new test file in the worktree to
prove an interleaving or an input the suite does not cover, run it, and
delete it. Probe budget: `lens: behaviour` four probes, `lens: tests` six,
`lens: both` nine. Restore the tree before you report.

## Lens: behaviour (`lens: behaviour` or `both`)

First list every function whose body the diff adds or changes, one line
per file: `path: fnA ok, fnB F2`. A moved file with no other change is
`path: moved`.

Then answer, for each of them:

1. What input, state, error path or interleaving makes it return the wrong
   thing or leave the wrong state? Two callers at once, a restart midway, a
   timeout, an empty list, a bound crossed.
2. What other code acts on the same state (the same records, files,
   processes, timers or locks)? Find each with a search, not from memory.
   For each: what happens when both act, in either order or at once?

Blocking: the change breaks behaviour, leaves wrong state, or breaches a
rule or an accepted ADR; a user or a later change pays for it. When unsure,
ask "what breaks, and for whom?"; no answer means note.

## Lens: tests and rules (`lens: tests` or `both`)

First list every test the diff adds or changes by line, never by title,
one line per file: `file: 12 read ok, 40 probed ok, 88 probed F3`. A file
whose tests only gained a fixture field: `file: fixture only`.

Then answer:

1. For each test: can it fail for the reason its title gives? Read it
   against testing rule 10's list first; those shapes need no probe to
   prove. Spend your probes on the tests most likely to be wired to
   nothing: break the code the title names and see whether the test goes
   red on an assertion. A test that stays green is a finding.
2. Does the diff break any rule in `rules/`? Cite the file and the rule
   number.

Blocking: a test that cannot fail for the reason its title gives, or a
breach of a rule or an accepted ADR.

## Assessment

Follow `review-protocol.md` in the inputs. End with `Assessment: complete`
or `Assessment: incomplete — <missing scope and reason>`. Exhausted budget
or missing evidence is incomplete, never a defect or F0/pass. Findings
already supported remain valid; identify unresolved coverage separately.

## Output

A finding is blocking only when it shows wrong behaviour or state, a false
statement, a rule or ADR breach, or a line of the specification left
undelivered or unproven. Testing rules and always-in-scope coverage apply
even when the spec omits a case. Extra coverage beyond those requirements,
a stronger assertion than its claim needs, or defensive code is a note.
`F0` is a good result: do not look for findings to have some.

Output only your lists, then your findings: no preamble, no headings, no
summary, no narration. Report every blocking finding; there is no limit.
At most five notes, each a possible wrong behaviour or state you could not
prove within your probes; write no other note. One line per defect, in
this form and no other:

```
F<n> B|N <path:line> <the defect, at most 25 words> [<class>] ev: <path:line, ...> | <command> => <the output line that shows it>
```

B is blocking, N a note. `<class>` is the rule it breaks (`testing 2`,
`architecture 13`), or the general rule in at most 8 words when no rule
file states it. A finding counts only with a concrete failure (this input
or state gives this wrong result) or a named cost and who pays it. Drop
style, naming and "could be simpler" with no defect. Whether the suite
passes is not yours to judge: CI runs it on every push. Do not suggest
fixes. No findings after complete assessment: `F0`. Append the Assessment line.
