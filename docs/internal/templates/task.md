<!--
Task spec. A spec session writes this as a sub-issue of a feature.
A task is task:draft until the Technical spec is filled in, the approval box
is ticked, and every issue under "Depends on" is closed.
-->

Part of #NNN.

## Scope

<!-- The slice of the parent's outcome this task delivers: what a user can do
after this PR merges that they could not after the previous one. -->

## In short

<!-- Two or three plain sentences: what changes for the user after this PR,
then a small Mermaid diagram of the flow it touches, with the changed step
marked. Define any new term here with an example. When the task changes
what input is accepted or what the tool prints, add the user's session
(commands and output, before and after) and an inputs table with today's
result beside the new one. End with one line: what a user would notice if
this task goes wrong. -->

## Technical spec

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

<!-- First, one line: the seam the tests drive (the highest existing entry
point that can see the behaviour; one if possible) and an existing test
file to model them on. Then one line per test title: a claim the body must
prove. Every behaviour the body states, including what stays "as today",
has a line here. -->

- ...

## Done when

<!-- Observable checks a reviewer runs before merging. A line that needs a
real simulator or emulator says so and names the slow-lane test that proves it. -->

- ...

## Out of scope

## Depends on

<!-- One issue per line. Leave empty if none. -->

- #NNN

## Approval

- [ ] Approved for delivery
