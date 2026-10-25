# Mode `build`: one test, then the code it needs

Build the issue one Tests line at a time (a bug's triage test already
exists: its line is the first cycle's, with step 1 done).

**Tracer bullet first.** The first cycle takes the line whose test crosses
the most of the path the issue builds, from its seam to its outermost
effect: the CLI command through the daemon to the stored record, not the
parser alone. Its green builds every layer on that path, each only as thick
as this one test needs: one case, no options, no error path. It proves the
layers connect before any of them grows, so a wrong seam or a missing wire
shows in cycle one, not in the last. Each next cycle takes the line next to
code already built and widens it by one case, field or error path, using
what the earlier cycles showed. Never build a layer ahead of the test that
reaches it, and never write the tests in bulk first: tests written before
the code check an imagined shape.

Before the first cycle, open `docs/internal/agent-rules/testing.md` and
read rules 1 to 3, 6, 7 and 10: they are what the review's tests lens
judges every test by, and the questions below are their short form, not
their replacement.

For each line, one cycle:

1. **Red.** Before writing the test, answer four questions; one you cannot
   answer means the line gets no new test:
   - What does it protect? A behaviour a caller, a user, a stored record
     or an event can see, at the seam the line names.
   - What realistic bug makes it fail, on a named assertion?
   - Why does no existing test catch that bug? Search first: a test that
     proves the behaviour next to it is extended (a case, a row), never
     copied (testing rule 7).
   - Does it need a hook in production code (an exported helper, a
     test-only flag or argument)? Then test from the real entry point.

   A line that only wires, re-exports, delegates or changes a type gets no
   red step: the tracer bullet proves the wiring. A line that lists cases
   is one test, its cases a table in its body. Its title is the line's
   claim, word for word where it fits. No assertion on a deadline, a
   duration, a throughput or a frame time without a fake clock: a bound on
   real time belongs in a `*.timing.test.ts` file or the slow lane, never
   in a unit or e2e assertion; it is the cause of most `flaky-test`
   issues. The commit hook typechecks the whole project, so a test that
   calls code not yet written cannot commit: add only the stub it calls,
   its real signature returning the type's emptiest value (`[]`, `0`,
   `undefined`, or doing nothing), never the logic. Run its file: it fails
   on a named assertion, for the reason the line gives, not on a typo, a
   thrown stub or a timeout (testing rule 2). Commit the test and its
   stubs, one test per commit: `git commit -m "test: <the line's claim>
(#<N>)"`. A test that passes before you change code either proves
   behaviour the repo had before this issue (delete it when an existing
   test proves the line, else keep it and list the line under `open` as
   `already green: <line>`), or code an earlier cycle built ahead of its
   test: keep it and list the line as `built ahead: <line>`.

2. **Green.** Write only the code this test needs to pass: no branch,
   case, field or error path that a later Tests line asks for, even when
   you can see it coming. What you write is the general logic the spec
   describes, never a value or branch that matches only the test's input;
   a field the type needs but no Tests line asserts is computed from
   state, never a placeholder (`ready: 0`). Run the files of every earlier cycle's test:
   they stay green. Commit: `<type>(<scope>): <what now works> (#<N>)`.

Never write the next test before this one is green, and never refactor
between cycles: the last cycle's push runs Fallow's duplication and
complexity checks on everything the cycles added, and you fix what they
flag then. Changing an earlier
cycle's test to make this one pass is a `spec needs` stop (above).

After the first cycle, push and open the draft PR:

```bash
LEFTHOOK_EXCLUDE=fallow git push -u origin <kind>/<N>
gh pr create --draft --base <base, or main> --title "<type>(<scope>): <summary>" --body-file <scratch>/pr-<N>.md
```

The push skips Fallow alone until the last cycle: stubs and code a later
cycle wires in are dead code until then. The last cycle's push runs every hook. With a
`base` argument (a task stacked on its feature's last reviewed PR), the PR
targets that branch. The PR body, in this order: `Closes #<N>`; a
`### Status` section the orchestrator keeps current; the Done when lines
as an unchecked list; `## Assumptions` ("none", or one `- Assumption:` line
per gap); the line `*Written by an agent.*`. Keep it current as you go.

- Every test command runs in the foreground with `timeout: 600000` set on
  the Bash call, and nothing is left running: no `run_in_background`, no
  trailing `&`, no loop that sleeps, no bare `cat > file`. The tool guard
  refuses each; a background job would hold your report until it ends or
  hits its 30-minute cap, which stalls the whole delivery.
- Run only the commands under "Tests agents run" in `toolchain.md`. Never
  run a check listed under "Checks agents never run", nor a tool behind
  it, from any path. A type or lint error shows in the commit hook's
  output.
- The commit hook rejects a comment that does not start with `why:`
  (architecture rule 17). Delete it; start it with `why:` only when it says
  why the code does something a reader would not expect.
- Never wait on CI. Run `node .agents/scripts/ci-failures.mjs <M>` at most
  once, before the report: `none` is `ci: pass`, a failed test `ci: fail`.
- Never use `git stash`: all worktrees share one stash list. Commit instead.
  Temporary files go in your scratchpad, not `/tmp`.
- Build what `always-in-scope.md` lists as you go. Anything else you notice
  outside the spec becomes a `bug:new` issue or one line under `open`.

Stop after about ten cycles, or sooner when your context grows long: push,
and list the Tests lines not yet built under `remaining`, in order. A fresh
agent goes on from the branch.
