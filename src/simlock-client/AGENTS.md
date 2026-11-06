# Typed client implementation

Does: the one implementation behind `simlock/client` and `simlock/admin` — one connection, typed calls.

## Rules

- Never reconnects, retries or renews: frontends own that policy.
- Never imports core, daemon or drivers. Every type in `types.ts` is `z.infer`red from the contract; `no-core-leak.test.ts` checks the emitted declarations.
- `hello` first; a version mismatch yields a client whose every call rejects with it, but `stopDaemon` and `updateDaemon` (the two frozen calls) work.
- A line over `MAX_WIRE_LINE_CHARS` (`wire.ts`) with no newline closes the connection; `ConnectOptions.maxLineChars` lowers it, as the gateway's worker uplink does.
