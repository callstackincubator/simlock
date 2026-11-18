# Client

Does: the `simlock/client` package entry — the typed client for agent operations.
Surface: [programmatic-client.mdx](../../website/src/content/docs/docs/using-devices/programmatic-client.mdx).

## Rules

- Sends no credential. On the daemon's socket the session is `agent`; with `url` and `token` it is the token's role, and the farm decides it.
- No reconnect, retry or renew here.
- Never imports core, daemon or drivers: every exported type comes from `src/simlock-client/`, and `src/simlock-client/no-core-leak.test.ts` checks the emitted declarations.
