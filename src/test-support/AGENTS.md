# Test support

Does: test-only helpers shared across modules; excluded from the build.
Entry: `imports.ts` → `importsOf`, `importSpecifiers`, `normalizeSpecifier`; `promise-state.ts` → `promiseState`; `source-text.ts` → `blankSource`.
Uses: Node built-ins only. Used by: module-boundary tests, fake-clock timing tests and the repo-wide source greps.

- `imports.ts` is the one import scanner: static, side-effect, re-export and dynamic imports,
  comments stripped, specifiers normalized to `src/`.
- `blankSource` blanks a source file's comments (and with `strings`, its string and template
  text), keeping every newline, so a repo-wide grep matches only code at the right line.
- `promiseState` reads whether a promise settled without awaiting it, so a broken timer fails
  on an assertion, not a test timeout.
