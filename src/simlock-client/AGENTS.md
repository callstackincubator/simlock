# Typed client implementation

Does: the one implementation behind `simlock/client` and `simlock/admin` — one connection, typed calls.
Entry: `client.ts` → `connectSimlockClient(options, admin)`; `SimlockWire` (`wire.ts`) for framing.
Uses: contract, daemon-protocol, link (byte channels), ports. Never imports: core, daemon, drivers.

- `SimlockWire`: newline JSON frames, request ids, push routing, `DAEMON_CONNECTION_LOST` on close.
  A repeated `lease-lost` for one lease is delivered once.
- `hello` first; a version mismatch yields a client whose every call rejects with it, but `stopDaemon` works.
- Every type in `types.ts` is `z.infer`red from the contract; `no-core-leak.test.ts` checks the emitted declarations.
- Never reconnects, retries or renews: frontends own that policy. `test-support.ts`: `ScriptedConnection`.
