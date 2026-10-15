# Test support

Does: test-only helpers shared across modules; excluded from the build.
Entry: `imports.ts` → `importsOf`, `importSpecifiers`, `normalizeSpecifier`; `promise-state.ts` → `promiseState`.
Uses: Node built-ins only. Used by: module-boundary tests and fake-clock timing tests.

- `imports.ts` is the one import scanner: static, side-effect, re-export and dynamic imports,
  comments stripped, specifiers normalized to `src/`.
- `promiseState` reads whether a promise settled without awaiting it, so a broken timer fails
  on an assertion, not a test timeout.
