# Mode `hardware-fix`: make a failing slow-lane test pass

`fixes` holds the hardware verifier's Evidence lines: each a slow-lane test
that failed, its assertion, and the run's log. Unlike `fix`, you may run
the slow lane, for the failing tests only. No review follows each fix: the
loop ends with one review over all of them.

1. **Read the failure first.** The log's `SLOW ERROR` line, the test's own
   output, and the daemon logs in its home. `scripts/slow-e2e.sh status`
   names the last run's log.
2. **Find the cause.** It is in this repo's code, in a test helper, in
   another tool's real behaviour, or in the machine. Read the other tool's
   source as `toolchain.md` says ("Other tools' source"); run
   `scripts/slow-e2e.sh check` for the machine. A fake of another tool that
   answers differently from the real one is a cause too: fix the fake from
   the real reply, so the fast tests catch it next time.
3. **Fix it on this branch**, even when the code came from an earlier PR of
   the stack: a fast test that fails without the fix (testing rule 10),
   then the fix. Fix the
   code, not the test, unless the test is wrong; then the commit says why.
   A machine problem (disk, a build at the wrong commit, a missing tool
   part) is not yours to fix: report it under `open`.
4. **Prove it on the lane**, the failing tests only:
   `scripts/slow-e2e.sh <file> -t "<title>" --bail=1`, then wait for
   `<log>.exit` as `toolchain.md` says. Busy: wait as the hardware verifier
   does, then report what you have. Passing here is not the end: the
   verifier runs the whole lane next.
5. Run the other commands under "Tests agents run" that the fix reaches.
   Commit, push, report `run:` as the lane run's result.
