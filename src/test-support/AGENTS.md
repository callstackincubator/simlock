# Test support

Does: test-only helpers shared across modules; excluded from the build.

## Rules

- `imports.ts` is the one import scanner: static, side-effect, re-export and dynamic imports,
  comments stripped, specifiers normalized to `src/`. A boundary test uses it; it does not parse
  imports by itself.
- A repo-wide grep over source runs on `blankSource` output: it blanks comments (and with
  `strings`, string and template text) and keeps every newline, so a match is code, at the
  right line.
- `promiseState` reads whether a promise settled without awaiting it, so a broken timer fails
  on an assertion, not a test timeout.
- `startOnFreePort` starts a daemon on a picked loopback port and picks another when the bind
  fails with EADDRINUSE (up to 5 tries): the picked port is released before the daemon binds it,
  so a process of a parallel lane can take it. A rig that binds a port it picked starts through
  it; `e2e/helpers` re-exports it, and a flow that starts a daemon over HTTP uses `withHttpDaemon`.
