<!--
Feature spec. A spec session writes this; nobody edits it by hand.
Sections up to "Open questions" are the business spec and never contain
implementation detail unless the detail is itself a requirement. The same
session adds "Decisions" and the design ("Behaviours", "Stored state",
"Interfaces", "Existing code"), has it checked against the code, and only
then writes "Tasks" and the task sub-issues. A design fact is written
once, in the row that owns it; every other line, here or in a task, names
the row's id.
-->

Request: #NNN <!-- or "none" when the maintainer originated it -->

## Problem

<!-- What is wrong or missing today, in one or two paragraphs. -->

## Who it is for

<!-- The person or agent that has the problem, and the situation they are in. -->

## Outcome

<!-- What they can do after this lands that they cannot do now. Observable
behaviour only. -->

## How it works for the user

<!-- A Mermaid flowchart or sequence diagram of what the user does and sees,
step by step, including the failure paths. GitHub renders ```mermaid
blocks. Then the user's session: the exact commands a user types and what
the tool prints back, before this feature and after it, error output
included. -->

## Examples

<!-- For any rule that accepts, rejects or matches input: a table of inputs
and results, with today's result beside the new one, so a changed answer is
visible. Include the odd cases (names, ranges, empty, unknown).

| Input | Today | After |
|---|---|---|
| `--os 18.4` | accepted | accepted |
| `--os Baklava` | accepted | accepted | -->

## What could go wrong

<!-- Two to five plain lines: what a user would notice if this goes wrong,
and how likely it is. No code terms. -->

## Words used

<!-- Every term this spec relies on that a newcomer would not know, or that
a rule depends on, one line each with an example: "bare version: an OS
version with no range, e.g. `--os 18.4`". "none" if there are none. -->

## Non-goals

<!-- What this feature deliberately does not do, so nobody scopes it back in. -->

## Completion conditions

<!-- How anyone would check the outcome. Each line is something a person or
an end-to-end test can verify against main. -->

- ...

## Open questions

<!-- Anything unresolved: a decision the maintainer has not taken, a fact
no source settles yet, two sources that disagree (name both). Never
guess past one. Empty before the feature leaves feature:spec. -->

## Decisions

<!-- One line per ADR this feature depends on. -->

- ADR NNNN — <title>: <one line on what it fixes for this feature>

## Behaviours

<!-- From the interview. One row per thing an invoker does and what it
then sees: a caller, a user at the CLI or the console, a stored record, an
event. Ids B1, B2, and so on; an id is never reused. The seam is the
highest existing entry point that can see it (a command, a route, a tool
call, a module's index.ts), with the platform faked, never a real device.
Cases are the inputs that differ in outcome; they become one table in one
test. Every refusal, printed line and failure a caller can see in the
tables below is a case of a row here. Task is `T1`, `T2` until the tasks
are posted, then their numbers. A task's Tests lines are its rows, one
line per row. -->

| Id | Behaviour (invoker, action, what it sees) | Seam | Cases | Task |
| -- | ----------------------------------------- | ---- | ----- | ---- |
| B1 | ...                                       | ...  | ...   | ...  |

## Stored state

<!-- Every record, table, column, file, folder or process this feature
adds or changes, one row each, ids S1, S2. Who creates, changes and deletes
it, in which order with the rows it belongs to. What lists or sweeps it:
the startup read, doctor, nuke, a list command. What a restart in the
middle of the step leaves, and who cleans that up. Schema step is
`<owner> +1` for the owner's next migration, `+2` for the one after, or
`none`: never a version number. Task is the one task that adds the row's
state; every task that later reads, writes or extends it is under Used
by, and a column a later task adds is a row of its own. A cell with
nothing to say holds `—`. `none` when the feature stores nothing. -->

| Id | What and where | Created, changed, deleted by | Listed or swept by | A restart mid-step leaves | Schema step | Task | Used by |
| -- | -------------- | ---------------------------- | ------------------ | ------------------------- | ----------- | ---- | ------- |
| S1 | ...            | ...                          | ...                | ...                       | ...         | ...  | ...     |

## Interfaces

<!-- Everything one task provides and another uses, and every call that
crosses a module, a process or another tool, one row each, ids I1, I2: an
operation, a function or port, a route, a command and what it prints, an
event, an error. Shape: the name, each field with its type, bounds and
allowed characters, required or optional. Errors: each code with its
message word for word, variable parts named; for a call that can hang,
the time limit and when it starts counting. A contract shape change says
"bumps the protocol by one" in its row, never a version number; an event
names its EVENTS.md entry. A new module or a second implementation names
its factory, handle and registry here (architecture rules 18 to 20). Task
is the one task that adds it; every task that calls, implements or
extends it is under Used by. `none` for a feature with one task and no
crossing call. -->

| Id | What | Shape and bounds | Errors and limits | Where | Task | Used by |
| -- | ---- | ---------------- | ----------------- | ----- | ---- | ------- |
| I1 | ...  | ...              | ...               | ...   | ...  | ...     |

## Existing code

<!-- First line: `Commit <sha>.`, the commit every path:line in this body
was read at. Second line: `Searches:` and the searches run, with hit
counts. Then every existing reader and writer of the state above, and
every code path the feature changes behaviour of, found by searching for
the state itself, not for names; ids X1, X2. What it does today, what
happens once both act, in either order, and the row or task that handles
it. A fact about another tool cites its source at the version
toolchain.md names. `none` only after the search. -->

Commit <sha>.

Searches: ...

| Id | Code (path:line) | Today | With this feature | Handled by |
| -- | ---------------- | ----- | ----------------- | ---------- |
| X1 | ...              | ...   | ...               | ...        |

## Tasks

<!-- Written after the design is checked and approved. First a Mermaid
flowchart of the tasks in the order they depend on each other (none for a
one-task feature). Then one entry per task, in that order:

- #NNN <title> — <one plain sentence: what the user can do after it>.
  Risk: <what a user would notice if it goes wrong>.

Then each Completion condition and the task whose Done when line delivers
it. Then the open work in the same area (other features' tasks, open PRs):
each one, what it shares with this feature, and the Depends on it got or
why none.

Do not write task states here: GitHub's sub-issue list shows them and
stays current. -->
