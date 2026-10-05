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
step by step, including the failure paths. Then one short example: the
command or request before this feature and after it, with its real output.
GitHub renders ```mermaid blocks. -->

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

## Technical spec

<!-- Only for a feature delivered as one PR. Delete this section when the
feature is split into tasks. -->

### Modules touched

### Contract and event changes

<!-- Every new or changed event needs its EVENTS.md entry named here. -->

### Rules in play

<!-- Which files in docs/internal/agent-rules/ the implementer must reread, and why. -->

### Tests

<!-- Each line is a test title: a claim the body must prove. -->

- ...
