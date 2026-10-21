# Admin client

Does: the `simlock/admin` package entry — the typed client with every admin operation.
Entry: `index.ts` → `connectSimlockAdmin({ endpoint | connection, principal?, credential? })`.
Uses: simlock-client, ports (`NodeIpcTransport` by default). Never imports: core, daemon, drivers.

- The session is `admin` only with a valid `credential` (operator token or `admin.token`);
  a wrong one fails `hello` with `ADMIN_AUTHENTICATION_FAILED`. None: an `agent` session.
- Types are re-exported from `src/simlock-client/`. No reconnect, retry or renew here.
- Surface: [programmatic-client.mdx](../../website/src/content/docs/docs/using-devices/programmatic-client.mdx).
