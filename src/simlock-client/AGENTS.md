# Typed client implementation

Does: the one implementation behind `simlock/client` and `simlock/admin` — one connection, typed calls.

## Rules

- Never reconnects, retries or renews: frontends own that policy.
- Never imports core, daemon or drivers. Every type in `types.ts` is `z.infer`red from the contract; `no-core-leak.test.ts` checks the emitted declarations.
- `hello` first; a version mismatch yields a client whose every call rejects with it, but `stopDaemon` and `updateDaemon` (the two frozen calls) work.
- `url` and `token` (`remote-connector.ts`) replace the local transport with a farm's session path; `farm-url.ts` is the one URL rule, which `simlock tunnel` shares. A revoked token (close 4003) rejects with `UNAUTHENTICATED`; 45 s without the farm's ping, or a drop, with `DAEMON_CONNECTION_LOST`.
- A line over `MAX_WIRE_LINE_CHARS` (`wire.ts`) with no newline closes the connection; `ConnectOptions.maxLineChars` lowers it, as the gateway's worker uplink does.
