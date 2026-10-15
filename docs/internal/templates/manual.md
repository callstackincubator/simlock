# Module manual template

A module manual is `src/<module>/AGENTS.md`, beside a one-line
`src/<module>/CLAUDE.md` that holds `@AGENTS.md`. Claude Code and OpenCode
load it when they read a file in the module; Codex and others load it by the
rule in the root `AGENTS.md`. It says what the module does today,
how, and what a change must not break. Rationale lives in ADRs; history in
git. Budget: 150 lines.

Write like a checklist in a cockpit: short lines, numbered steps, defaults
next to the knob. Name files and exported names, never private members
(`#field`). A test checks that every backticked `.ts`, `.tsx`, `.mjs`, `.js`
or `.md` path, and every path ending in `/`, exists.

```markdown
# <Module>

Does: <one line>.
Entry: `index.ts` → `createX()`.
Uses: <modules>. Never imports: <modules>.
Flows: <links to other manuals or docs/internal/flows/ it takes part in>.

## Files

| File | Role |
|---|---|
| `x.ts` | <5–10 words> |

## How it works

1. <step> — `file.ts` `function`.

## State and timers

<what it writes, where, who else may write it; each timer with its config
key and default>

## Rules

- <invariant a change must not break, with the test that pins it if any>

## Known gaps

- **<gap>.** <2–3 lines: what happens, the knob or workaround, issue link>.
```

Drop a section that would be empty. A module of one or two files gets
`Does`, `Entry`, `Uses` and nothing else.
