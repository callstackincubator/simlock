# Admin client

Does: the `simlock/admin` package entry — the typed client with every admin operation.
Surface: [node-client.mdx](../../website/src/content/docs/docs/using-devices/node-client.mdx), [reference/node-client.mdx](../../website/src/content/docs/docs/reference/node-client.mdx).

## Rules

- The session is `admin` only with a valid `credential` (operator token or `admin.token`); a wrong one fails `hello` with `ADMIN_AUTHENTICATION_FAILED`. None: an `agent` session.
- With `url` and `token` the token is the credential: `credential` is refused with `url`, and the session's role is the token's.
- No reconnect, retry or renew here.
- Never imports core, daemon or drivers: every exported type comes from `src/simlock-client/`, and `src/simlock-client/no-core-leak.test.ts` checks the emitted declarations.
