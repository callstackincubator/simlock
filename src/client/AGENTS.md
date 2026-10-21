# Client

Does: the `simlock/client` package entry — the typed client for agent operations.
Entry: `index.ts` → `connectSimlock({ endpoint | connection, principal? })`.
Uses: simlock-client, ports (`NodeIpcTransport` by default). Never imports: core, daemon, drivers.

- Sends no credential, so the session is always `agent`.
- Types are re-exported from `src/simlock-client/`. No reconnect, retry or renew here.
- Surface: [programmatic-client.mdx](../../website/src/content/docs/docs/using-devices/programmatic-client.mdx).
