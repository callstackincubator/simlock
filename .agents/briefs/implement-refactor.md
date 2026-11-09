# Mode `refactor`: pin, refactor, delete the pins

The issue is a refactor (delivery rule 18): its body is Why, Target shape,
Out of bounds and Done when, and it has no Technical spec. Behaviour does
not change, bugs included. Open `docs/internal/agent-rules/delivery.md`
rule 18 and `testing.md` rule 2 before you start.

This mode replaces `build` and `audit`: one run takes the branch from
empty to a draft PR the review can read.

1. **Draft the refactor first, off the branch.** In the task's worktree,
   `git switch -c refactor-draft-<N>` from the base and make the whole
   Target shape there, in local commits you never push. Move code
   verbatim where you can: a moved line reads as moved in review and in
   `refactor-check.mjs`. Change no test's expected value. Rename a test
   only when it moves with the code it covers, keeping its title. When
   the shape needs a behaviour change, an existing test's expected value
   changed or a module surface changed, stop (step 6).
2. **Find what no test pins.** `git switch refactor/<N>`, still at the
   base. Run

   ```bash
   pnpm mutate --touched-by refactor-draft-<N>
   ```

   It mutates the base's source lines the draft moves or changes and runs
   the tests. Every mutant it prints alive is behaviour no test pins.

3. **Pin it.** For each survivor write a pin in a `*.pin.test.ts` file
   next to the test file of the seam that pins it: a test of what the
   code does today, on the base, through the nearest seam the refactor
   does not move (a module's `index.ts`, a command, an HTTP route). A
   table of inputs and today's outputs is fine; so is today's wrong
   answer: a pin records, it does not judge. A pin fails for the right
   reason (testing rule 2): break the line once and watch it go red.
   Every pin passes on the base. Commit them as one commit, alone,
   `test(pin): pin <what> before the refactor (#<N>)`, and run step 2
   again, amending that commit, until nothing is alive. A survivor no
   seam can reach without importing an internal file is a stop (step 6).
   No survivor at all: no pin commit.
4. **Refactor on top.** `git cherry-pick` the draft's commits onto the
   pin commit, as `refactor(<module>): <what moved where> (#<N>)`. Run
   the pins and every test file the diff touches; all pass unchanged.
   Then delete every pin in one last commit, `test(pin): delete the pins
   (#<N>)`, and `git branch -D refactor-draft-<N>`. Keep a pin only when
   it covers a real gap; then move it into the module's test file in
   that commit, meeting all of testing.md, and say so in the PR body.
5. **Check, push, open the draft PR.**

   ```bash
   node .agents/scripts/refactor-check.mjs --base <merge-base> --head HEAD
   git push -u origin refactor/<N>
   gh pr create --draft --base main --title "refactor(<module>): <summary>" --body-file <scratch>/pr-<N>.md
   ```

   The check prints `Tests: <n> before, <n> after.` and the `Mutation:`
   line; a failure is yours to fix before the push. The PR body, in this
   order: `Closes #<N>`; a `### Status` section; the Done when lines as a
   ticked list, each with `— <how it was checked>`; those two lines from
   the check; a table of the files before and after when the refactor
   splits a file; `## Assumptions` ("none", or one `- Assumption:` line
   per gap); the line `*Written by an agent.*`.

6. **Stops.** Push what you have and report under `open`:
   - `spec needs: a task for <the behaviour, test or surface change>`;
   - `spec needs: a task; no seam pins <path:lines>`;
   - a bug found on the way: open it as `bug:new`, pin today's behaviour,
     and carry on; never fix it here.

   "While I'm here" is a stop too: anything outside the Target shape
   becomes a `refactor:new` or `bug:new` issue, or a line under `open`.

- Every test command, `pnpm mutate` and `refactor-check.mjs` included,
  runs in the foreground with `timeout: 600000` on the Bash call.
- `pnpm mutate --touched-by` is the one mutation run you may make; never
  `pnpm mutate` without it, nor any other check under "Checks agents
  never run".
- Never use `git stash` or `git rebase`. The draft branch is local only.
- Report `tests: <after>/<before>` and leave `cycles` out.
