# Stage 4: design

Write the feature from `docs/internal/templates/feature.md`, have it
checked against the code, and get the maintainer's one approval. No task
body exists until this stage is done.

## Write

1. The business sections, from the interview. Push back on anything that
   names a mechanism where an outcome is meant.
2. Behaviours: one row per thing an invoker does and sees, with its seam
   and cases. Split the feature into tasks here: vertical slices, each a
   PR one agent can land, about ten Behaviours rows and twenty modules at
   most. A small feature is one task. Task cells hold `T1`, `T2`. A row
   that claims "every", "any", an order or one write names the cases that
   prove it; a claim an existing test already proves names that test.
3. Stored state, Interfaces and Existing code, as each template comment
   says. Fill Existing code by searching for the state and the code paths
   the feature changes, not for names. Open every line you cite. For each
   value a row sends to another module, process or tool, open the line
   that accepts it and check the value passes.
4. Walk each Behaviours row through the code: its entry point, each
   function that must change, each thing it needs from another task. What
   it needs is a row; add the ones the walk finds. A point you cannot
   settle goes under Open questions, never into a row as a guess.

Then, on the draft file:

- every refusal, printed line and failure a caller can see in Stored
  state and Interfaces is a case of a Behaviours row;
- every Completion condition has a Behaviours row that delivers it;
- every task that uses a row lists itself under that row's Used by;
- `node .agents/scripts/spec-lint.mjs --feature --body-file <file>` prints
  no `B` line.

## Post

Open questions must be empty first: ask them in one round. Then, without
asking:

```bash
gh issue edit <N> --body-file <file>
gh issue comment <N> --body-file <file holding: Design posted: <sections added or changed, one line>.>
```

Push every ADR draft to its PR branch.

## Check

Start `spec-checker` agents with the Agent tool, all in one message:

- three or more tasks: three checkers, `#<N> design build`,
  `#<N> design handoffs`, `#<N> design break`;
- fewer: one, `#<N> design all`.

Write nothing while they run but the answers to questions they do not
touch. When all have reported:

1. Fix each blocking finding marked `Decision: no` in the row it names,
   and in every row that cites that row. Only you edit the body.
2. Put every finding marked `Decision: yes` to the maintainer in one
   interview round, then fold the answers into the rows.
3. Post the body. `SendMessage` each checker that reported a blocking
   finding `recheck` and the diff of the body, nothing else. Fix what it
   reports and send that diff once more. A finding still open after that
   goes into the approval, not into another fix.

Notes never start a round: fix one when the fix is one row and decides
nothing.

## Approve once

Ask the maintainer once, with `AskUserQuestion`, above a summary this
short:

```
#<feature> <title>: <link>
ADR <nnnn> (PR #<n>): <what it decides, one or two lines>
Decided in the session: <each one, a line>

| Task | What it delivers | Rows | Depends on |
| ---- | ---------------- | ---- | ---------- |
| T1   | <one line>       | B1, B2, S1 | —    |

Check: ready | <n> open findings, one line each
```

The options: approve; approve and accept the open findings listed; or
change something, which reopens the interview for that point and the
check for the rows it changes. On approval, set every ADR the feature
links to _Accepted — not yet implemented_ on its PR branch. An accepted
ADR's PR stays open: it is the bottom of the feature's stack (delivery
rule 15).
