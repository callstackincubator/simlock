# Module manual template

A module manual is `src/<module>/AGENTS.md`, beside a one-line
`src/<module>/CLAUDE.md` that holds `@AGENTS.md`. Claude Code and OpenCode
load it when they read a file in the module; Codex and others load it by the
rule in the root `AGENTS.md`. It says what a change must not break and the
code does not show (documentation rule 7). Rationale lives in ADRs; history
in git. Budget: `MANUAL_CHARACTERS` for one manual and
`MANUALS_TOTAL_CHARACTERS` for all of them together, both in
`src/docs-manuals.test.ts`. A new line fits in what is left or replaces
one; raising either number is a change the review sees.

Before you write a line, ask: would an agent that read the module's index
and the file it is changing get this wrong? If not, leave the line out.

Never in a manual:

- a list of files and their roles, or of what the module imports;
- an inventory of commands, components, fields or events;
- a default, limit or timeout (name the config key or the constant);
- steps that follow one function's body.

Name files and exported names, never private members (`#field`). A test
checks that every backticked `.ts`, `.tsx`, `.mjs`, `.js` or `.md` path, and
every path ending in `/`, exists.

```markdown
# <Module>

Does: <one line>.
Flows: <links to other manuals or docs/internal/flows/ it takes part in>.

## Rules

- <an invariant across files, an order to keep, a "never" or a trap; name
  the test or lint rule that holds it when one does>

## Known gaps

- **<gap>.** <2–3 lines: what happens, the knob or workaround, issue link>.
```

Drop a section that would be empty. A module with no rule and no gap gets
its `Does` line and nothing else.
