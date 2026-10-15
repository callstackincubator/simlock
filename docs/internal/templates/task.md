<!--
Task spec. A spec session writes this as a sub-issue of a feature.
A task is task:draft until its Technical spec is filled in and its spec
check passes; the spec session then sets task:ready. "Depends on" sets only
the order of delivery.
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

### Facts

<!-- Every fact this spec rests on, one row each: what existing code,
another tool or this machine does today. Source: where it was read, a
`path:line` in this repo, a `path:line` in another tool's source at the
commit toolchain.md names, or a command and the output line it printed. A
value this change sends to another module, process or tool (an id, name,
key, header, path, flag, JSON shape) is a row: its source is the line that
parses or validates it, and the row shows the value passes. A fake of
another tool cites the real reply it copies. A sentence below about today's
behaviour names its row (F1). A fact with no source is an open question,
not a row. -->

| #  | Fact | Source |
| -- | ---- | ------ |
| F1 | ...  | ...    |

### Modules touched

<!-- A Mermaid flowchart of the modules this changes and the ones they call,
changed ones marked, arrows pointing from caller to callee. When the change
crosses a process or a network hop (CLI, daemon, driver, gateway, worker,
HTTP or MCP client), add a Mermaid sequence diagram of one request through
it, including the failure reply. Skip a diagram that would show one box. -->

### Surface and extension points

<!-- For each module this adds or whose `index.ts` it grows: the factory
and the handle it returns (architecture rule 18). If the change adds a
second implementation of something simlock already does, or an accepted
ADR or this spec names one: what varies, the definition type and the
registry (architecture rules 19, 20). Delete this section when neither
applies. -->

### Contract and event changes

<!-- Every contract shape the change adds or changes, or "none" after a search.
A shape change says "this PR bumps the protocol by one", never a version
number: another task may take the next one first, and the PR that merges
second bumps again when it takes the base branch. Every new or changed event needs its
EVENTS.md entry named here. -->

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
has a line here: one line per behaviour, its cases listed in the line, not
one line per case. A claim an existing test already proves names that test
to extend instead (testing rule 7). -->

- ...

## Done when

<!-- Observable checks a reviewer runs before merging. A line that needs a
real simulator or emulator says so and names the slow-lane test that proves it. -->

- ...

## Out of scope

## Depends on

<!-- One issue per line. Leave empty if none. -->

- #NNN
