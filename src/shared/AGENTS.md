# Shared

Does: small pure helpers two or more components use.

## Rules

- A helper goes in only if it is pure (no I/O, no clock, no state), imports nothing (no component, package or Node module; dependency rule `shared-imports-nothing`), and is used by two or more components. Anything else lives in the module that owns it.
- `errorMessage` is the one error-message unwrap; the copy check in `src/lint-rules.test.ts` refuses another.
