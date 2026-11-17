# Admin client

Does: the `simlock/admin` package entry — the typed client with every admin operation.
Surface: [programmatic-client.mdx](../../website/src/content/docs/docs/using-devices/programmatic-client.mdx).

## Rules

- The session is `admin` only with a valid `credential` (operator token or `admin.token`); a wrong one fails `hello` with `ADMIN_AUTHENTICATION_FAILED`. None: an `agent` session.
- No reconnect, retry or renew here.
- Never imports core, daemon or drivers: every exported type comes from `src/simlock-client/`, and `src/simlock-client/no-core-leak.test.ts` checks the emitted declarations.
