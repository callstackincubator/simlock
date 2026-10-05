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
marked. Define any new term here with an example. -->

## Technical spec

### Modules touched

### Contract and event changes

<!-- Every new or changed event needs its EVENTS.md entry named here. -->

### Rules in play

<!-- Which files in docs/internal/agent-rules/ the implementer must reread, and why. -->

### Tests

<!-- Each line is a test title: a claim the body must prove. -->

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
