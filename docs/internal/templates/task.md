<!--
Task spec. A spec session writes this as a sub-issue of a feature, after
the feature's design is checked and approved. The design lives in the
parent: a task names the parent's rows it delivers and never restates
one. "Depends on" sets only the order of delivery.
-->

Part of #NNN.

## Scope

<!-- The slice of the parent's outcome this task delivers: what a user can
do after this PR merges that they could not after the previous one. Last
line: what a user would notice if this task goes wrong. -->

## Technical spec

Commit <sha>.

### Rows

<!-- The parent's rows this task delivers, by id, one line per table:
"Behaviours: B3, B4", "Stored state: S2", "Interfaces: I5, I6", and
"Existing code: X4, X7" for the rows it must handle. The rows are the
spec. A detail no row holds goes into the parent's row first, never only
here. -->

### Facts

<!-- Only what no row of the parent holds: what existing code, another
tool or this machine does today that this task rests on, one row each.
Source: a `path:line` in this repo, a `path:line` in another tool's source
at the commit toolchain.md names, or a command and the output line it
printed. Docs, memory or "to re-check" is no source. `none` when the
parent's rows cover it. -->

| #  | Fact | Source |
| -- | ---- | ------ |
| F1 | ...  | ...    |

### Modules touched

<!-- Found by searching for every symbol the task adds, changes or
removes, files that break when it goes included; one line names the
searches. A Mermaid flowchart of the modules only when more than three
change. -->

### Rules in play

<!-- Each rule file and ADR section the task touches, one line each: the
file or section, and how the task complies. -->

### Retired words

<!-- Only when the task ends what a word means today: a behaviour it
removes or renames ("wiped" once a device is deleted instead, "reclaim"
once nothing is reclaimed). One bullet per word or phrase, backticked
first, then what replaces it, as in "- `wiped`: a virtual device is
deleted after its lease; only a physical device is wiped".
`stale-refs.sh` lists every line that still holds one, for the audit and
the claims review. Delete this section when nothing is retired. -->

- ...

### Tests

<!-- First, one line: the seam the tests drive and an existing test file
to model them on. Then one line per Behaviours row this task delivers,
starting with its id, in the row's words with its cases: "- B3: an
operator removes a baseline: unused; in use; unknown". About ten lines;
never a line for a row of another task or for "as today" (name the
existing test in prose instead). -->

- ...

## Done when

<!-- Observable checks a reviewer runs before merging. A line that needs a
real simulator or emulator says so and names the slow-lane test that proves it. -->

- ...

## Out of scope

## Depends on

<!-- One issue per line: the task of every Stored state or Interfaces row
this task uses. Leave empty if none. -->

- #NNN
