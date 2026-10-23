# Mode `audit`: prove it

You start fresh on purpose: judge the diff, not how it was built.
The orchestrator supplies immutable `base`, `merge-base` and `head` from the
actual PR inputs. After fixes it also supplies `previous` (last reviewed
commit): audit `git diff <previous> <head>` and affected contracts/classes,
not the whole PR again. Missing inputs mean incomplete assessment. Run the
stale-reference sweep with that same explicit range. Recheck affected Done
when and assumptions; retain earlier evidence for unaffected claims.

**Audit `git diff <merge-base> <head>`** as someone who has not seen the spec:

- **Removed.** Run `.agents/scripts/stale-refs.sh <range-start> <head>`: it lists every line in
  the repo that still names a path, declaration or quoted string the diff
  removed. Then, for every name, behaviour, limit or guarantee the diff
  removes, renames or narrows, search the repo (comments, docs, test titles,
  config, help text), directly or with bounded Haiku discovery following
  `docs/internal/EXPLORATION.md`, by
  its name and by the plain words that describe it. Fix every line that still states the
  old fact.
- **Replaced.** When one mechanism takes over another's job (a lint rule for
  a test, a type for a runtime check, a new module for an old one), list the
  cases the old one caught and prove each against the new one before
  deleting the old. A case the new one misses is a gap.
- **Accepted.** For every rule, pattern, filter or validator you add, try
  other spellings, other paths, other import or call forms, empty and
  boundary values. Each one it lets through gets a fixture or an `open`
  line.
- **Promised.** For every Scope and Done when line, name the hunk or test
  that delivers it. None: do it, or leave the line unticked and say why
  under `open`. Never tick a box on intent.
- **Covered, in the strict test areas only** (`toolchain.md`, "Project
  checks": `src/leasing/`, the named files of `src/core/`, the wire
  validators in `src/contract/`). List every function the diff adds or
  changes there, one line per file. For each: what a caller, a user, a
  stored record or an event sees when it runs, and which test goes red
  when its body, its new branch or its new argument is deleted (testing
  rule 3). Delete it once and run that test's file to see. No test goes
  red: write the one that does, through the module's surface (rule 6),
  or put the line under `open`. Report `covered <c>/<f>` on the `audit:`
  line: `f` functions listed, `c` with a red test; `0/0` when the diff
  touches no strict area. Outside the strict areas the spec's Tests lines
  set the tests, and you add none: a behaviour you find untested goes
  under `open` as `spec needs: <behaviour> at <seam>`, and a test the
  build added at a seam the Tests section does not name is folded into
  the test at the named seam, or deleted when that test already proves
  its claim (rule 7).

**Check every test you added or changed**, including setup or assertions
edited after its `test:` commit:

- Its title, assertions and fixture state make the same claim. A title with
  two claims has an assertion for each. Open
  `docs/internal/agent-rules/testing.md` and walk rule 10's list against
  it: a title clause with no assertion; "every" or "any" proved by one
  case; an order or a write read from the end state; an assertion a
  failure also satisfies; an expected value the code under test computed;
  state read from a copy taken before the act; a time boundary not
  straddled.
- It proves a claim no other test proves, through the module's surface
  (testing rules 6 and 7). One that repeats another test's claim is folded
  into that test. One that imports a module's internal file instead of its
  `index.ts` has the `why:` reason rule 6 asks for, or moves to the
  surface, even when `index.ts` exports the same name.
- Break the code it covers once per claim in its title (flip the
  condition, drop the filter, delete the call, move the constant either
  way, return early, or swap a rule for a near one: sort by another key,
  drop the tie-break, take the first instead of the lowest, drop one side
  of an `||` or `&&`) and run its file: it fails on the assertion its
  title names, not by timing out. Apply each break so that one which
  does not match fails loudly (a Python `str.replace` with an assert that
  the text was found, not `sed -i`): a break that never applied proves
  nothing. Restore the code. A test that stays green
  is vacuous: fix it. Every test, no skipping: a probe the audit skips, a
  reviewer does on a far costlier model. Report `probed <p>/<t>` on the
  `audit:` line: `t` tests added or changed, `p` probed.
- A test comparing two outputs also asserts one of them against a literal.

Run the "Project checks" in `toolchain.md` that the diff triggers. Then the
tests from mode `build` pass, and you push.

**A failing test you did not touch**, locally or in a failed CI run
(`gh run view <id> --log-failed`):

1. An open `flaky-test` issue names it
   (`gh issue list --label flaky-test --search "<title>"`): list it under
   `flaky` and move on.
2. Otherwise run that one file up to three times in a worktree of the base
   commit (`git worktree add --detach <scratch>/base <merge-base>`), with the
   one-file command from `toolchain.md` (testing rule 5). It fails there:
   open a `bug:new` issue labelled `flaky-test` naming the file, the title
   and the error line, list it, and move on. It never fails there: it is
   yours.

Never rerun the whole suite to decide. Never skip, disable or loosen a test.

**Slow lane.** List every Done when line that needs the slow lane
(`toolchain.md`) under `hardware`. Do not run it: the orchestrator does.
