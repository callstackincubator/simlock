# 0096. The Windows unit tests run in three shards, and on a pull request only when a change can reach them

- **Status:** Accepted
- **Date:** 2026-11-27
- **Narrows:** [ADR 0087](0087-the-unit-tests-run-on-windows-in-ci-and-a-list-of-files-still-failing-there-only-shrinks.md)
  §1 ("one job … on every push and pull request") and its first
  consequence ("every pull request waits for a Windows runner").

## Context

The Windows job reached `main` on 2026-11-24. Measured over the two weeks
around it:

- A green CI run on a pull request took a median of 5.2 minutes before and
  17.2 minutes after. The job's test step takes 11 to 17 minutes; every
  other job ends within 5.
- Of 40 failed runs in the 3.5 days after, 18 failed in the Windows job
  only, 3 of them on branches that change no code.
- 64 of the 376 pull requests merged in four weeks change no file the unit
  tests read.

## Decision

### 1. Three shards

The Windows unit tests run as three jobs, `Unit tests (Windows) (n/3)`,
each one third of the files. `Quality` needs all three.

### 2. A pull request runs them only when it changes a file they read

The `Changes` job decides. The shards run on a pull request that changes a
source, test, script or root build file, or the CI workflow; on every push
to `main`; and whenever `Changes` fails. On any other pull request they are
skipped, and `Quality` counts a skipped shard as passed. The file list
lives in the workflow, and a repository test pins it.

## Alternatives rejected

- **Keep one job on every pull request.** Every push waits 12 more minutes
  for a check that cannot fail on a docs change.
- **Run Windows only after the merge.** A Windows break would reach `main`
  before anyone saw it.

## Consequences

- A pull request that changes only docs, the website, agent config, e2e
  files or the Swift package merges with no Windows run. The push to `main`
  runs the shards.
- Three Windows runners are asked for at once.
