# 0096. The Windows unit tests run in three shards, and on a pull request only when its change can give another result on Windows

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
- 63 of the 376 pull requests merged in four weeks change only docs,
  website pages, agent config, e2e files or the Swift package.

## Decision

### 1. Three shards

The Windows unit tests run as three jobs, `Unit tests (Windows) (n/3)`,
each one third of the files. `Quality` needs all three.

### 2. A pull request runs them only when its change can give another result on Windows

The `Changes` job decides. The shards run on a pull request that changes a
source, test or script file, a workflow step or tool config the unit tests
run, or a root build file; on every push to `main`; and whenever `Changes`
fails. On any other pull request they are skipped, and `Quality` counts a
skipped shard as passed. The file list lives in the workflow, and a
repository test pins it.

Some unit tests read docs, website pages, agent config, e2e sources and
other workflow files as text. They give the same result on both hosts, and
the Linux unit job runs them on every pull request, so those files are not
on the list.

## Alternatives rejected

- **Keep one job on every pull request.** Every push waits 12 more minutes
  for a check that, on a docs change, repeats the Linux unit job's answer.
- **Run Windows only after the merge.** A Windows break would reach `main`
  before anyone saw it.

## Consequences

- A pull request that changes only docs, the website, agent config, e2e
  files or the Swift package merges with no Windows run; the Linux unit job
  has run the tests that read them. The push to `main` runs the shards.
- A unit test that starts to run a file outside the list, not only read
  it, adds the file to the list.
- Three Windows runners are asked for at once.
