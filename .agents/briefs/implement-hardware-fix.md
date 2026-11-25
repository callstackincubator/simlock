# Mode `hardware-fix`: make a failing slow-lane test pass

`fixes` holds the hardware verifier's Evidence lines: each a slow-lane test
that failed, its assertion, and the run's log, with the machine's load
before the run. Unlike `fix`, you may run the slow lane, for the failing
tests only. No review follows each fix: the
loop ends with one review over all of them.

1. **Read the failure first.** The log's `SLOW ERROR` line, the test's own
   output, and the daemon logs in its home. `scripts/slow-e2e.sh status`
   names the last run's log.
2. **Is it this PR's?** An Evidence line ending `(file not changed by the
   PR)` is a test the PR did not write. Before looking for a cause, run it
   once at the merge base: `.agents/scripts/worktree.sh --detach
   <merge-base> --prepare`, build there, then `scripts/slow-e2e.sh <file>
   -t "<title>" --bail=1` from that folder. It fails there on the same
   assertion: it is not yours. Open a `bug:new` issue naming the file, the
   title, the assertion and the commit, list the test under `open` as
   `base fails: <file> "<title>" at <merge-base> #<issue>`, and change
   nothing for it. It passes there: it is yours. A test that timed out
   in a run whose load was above the core count: run it alone once, at
   the head, before anything else. It passes: list it under `open` as
   `passed alone: <file> "<title>", load <n> in the failed run` and
   change nothing for it.
3. **Two fixes for one test have failed: test what they assumed.** The
   fixes are yours in this run or an earlier run's (`git log
   <previous>..`), and the test still fails on the lane. Write, in one
   sentence, what they shared ("the volume arrives within 30 s", "a
   settled copy uses less CPU", "the warning means a cold boot"). Make
   the one measurement that would come out differently if it were false,
   on the lane, before any further fix. It is false, and what fails is a
   bound or an expectation of the spec: no fix reaches it. Revert the
   fixes that assumed it, push, report `spec needs: <the row or Done when
   line> expects <x>, measured <y> (<runs>)` under `open`, and stop.
4. **Find the cause.** It is in this repo's code, in a test helper, in
   another tool's real behaviour, or in the machine. Read the other tool's
   source as `toolchain.md` says ("Other tools' source"); run
   `scripts/slow-e2e.sh check` for the machine. A fake of another tool that
   answers differently from the real one is a cause too: fix the fake from
   the real reply, so the fast tests catch it next time.
5. **Fix it on this branch**, even when the code came from an earlier PR of
   the stack: a fast test that fails without the fix (testing rule 10),
   then the fix. Fix the
   code, not the test, unless the test is wrong; then the commit says why.
   A machine problem (disk, a build at the wrong commit, a missing tool
   part) is not yours to fix: report it under `open`.
6. **Prove it on the lane**, the failing tests only:
   `scripts/slow-e2e.sh <file> -t "<title>" --bail=1`, then wait for
   `<log>.exit` as `toolchain.md` says. Busy: wait as the hardware verifier
   does, then report what you have. Passing here is not the end: the
   verifier runs the whole lane next.
7. Run the other commands under "Tests agents run" that the fix reaches.
   Commit, push, report `run:` as the lane run's result.
