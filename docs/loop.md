# Implementation loop

Instructions for the sub-agent implementing one Pitlane stage. You are given a
stage file path (for example `docs/stages/02-max-running.md`). Work through
these phases in order; do not skip the self-review.

## Phase 0 — Orient

1. Read `AGENTS.md`, all of `docs/agent-rules/`, and `docs/ARCHITECTURE.md`.
   The agent rules are binding; architecture violations are defects even if
   tests pass.
2. Read your stage file completely, and `docs/stages/README.md` to confirm
   every stage yours depends on is marked `done`. If a dependency is not
   done, STOP and report — do not implement around it.
3. Skim the existing code your stage builds on (the modules named in the
   stage file). Verify `pnpm check` is green before you change anything; if
   it isn't, STOP and report.

## Phase 1 — Tests first

4. Write the tests listed in the stage's "Tests first" section before any
   implementation. Run them; they must fail for the right reason (missing
   implementation, not typos).
5. Where the stage names a load-bearing test, write that one first.

## Phase 2 — Implement

6. Implement until the stage's tests pass. Follow the stage file's
   "Implement" section as the spec; where it's silent, ARCHITECTURE.md and
   the agent rules decide; where those are silent, choose the simplest thing
   and note the choice in your report.
7. Scope discipline: implement ONLY your stage. No future-stage work, no
   speculative abstractions. If you find a genuine gap that a later stage
   needs, leave a `TODO(stage-NN):` marker and mention it in your report.
8. New events → update `docs/EVENTS.md` in the same change (events rule 8).
   New external dependency → its port first (architecture rule 9). New
   runtime npm dependency → forbidden unless your stage file explicitly
   allows it.

## Phase 3 — Self-review

9. Run `pnpm check` (typecheck + lint + all tests, not just yours).
10. Read your full diff (`git diff`) as a reviewer, checking:
    - every acceptance criterion in the stage file, one by one;
    - every rule in `docs/agent-rules/architecture.md`, `events.md`,
      `safety.md` against the new code;
    - the stage's "Watch out" list;
    - test quality: would each test fail if the behavior regressed? Delete
      tests that can't fail.
11. Fix every issue found, then re-run `pnpm check`. Repeat until a review
    pass finds nothing.

## Phase 4 — Finish

12. Update `docs/stages/README.md`: flip your stage's Status to `done`.
13. Commit everything as ONE commit:
    `stage NN: <stage title>` + a body summarizing what was built, notable
    decisions, and any TODO(stage-NN) markers left. Do not push. Verify the
    working tree is clean afterwards.
14. Report back: acceptance criteria status (each one: met/not met + how
    verified), decisions made where the spec was silent, deviations from the
    stage file and why, and anything the next stage should know.

## Hard rules

- Never mark a criterion met without having verified it (run the test, run
  the grep, run the command).
- If the stage file conflicts with the code reality you find, STOP and
  report the conflict instead of improvising.
- If a live test (`PITLANE_LIVE_*`) is required by the stage, run it and
  report its actual output; if the environment lacks the prerequisite, say
  so explicitly — never claim a live test passed that didn't run.
