<!--
Feature spec. A spec session writes this; nobody edits it by hand.
Sections up to "Open questions" are the business spec and never contain
implementation detail unless the detail is itself a requirement.
"Decisions" and "Technical spec" are added in a later session. A feature
that is split into tasks gets sub-issues instead of a Technical spec.
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

<!-- Anything unresolved. Empty before the feature leaves feature:spec. -->

## Decisions

<!-- One line per ADR this feature depends on. Added during planning. -->

- ADR NNNN — <title>: <one line on what it fixes for this feature>

## Tasks

<!-- Added when the feature is split; replaces the Technical spec. First a
Mermaid flowchart of the tasks in the order they depend on each other. Then
one entry per task, in that order:

- #NNN <title> — <one plain sentence: what the user can do after it>.
  Risk: <what a user would notice if it goes wrong>.

Do not write task states here: GitHub's sub-issue list shows them and
stays current. -->

## Technical spec

<!-- Only for a feature delivered as one PR. Delete this section when the
feature is split into tasks. -->

### Modules touched

<!-- A Mermaid flowchart of the modules this changes and the ones they call,
changed ones marked, arrows pointing from caller to callee. When the change
crosses a process or a network hop (CLI, daemon, driver, gateway, worker,
HTTP or MCP client), add a Mermaid sequence diagram of one request through
it, including the failure reply. Skip a diagram that would show one box. -->

### Contract and event changes

<!-- Every new or changed event needs its EVENTS.md entry named here. -->

### Other code on the same state

<!-- Every existing component that reads or changes the state this change
touches (the same records, files, processes, timers or locks), found by
searching the code. For each: what happens when both act, in either order
or at once, and which one wins. "None" only after the search. -->

### Rules in play

<!-- Which files in docs/internal/agent-rules/ the implementer must reread, and why. -->

### Tests

<!-- Each line is a test title: a claim the body must prove. Every behaviour
the body states, including what stays "as today", has a line here. -->

- ...
