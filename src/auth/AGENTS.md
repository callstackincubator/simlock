# Auth

Does: turns a credential into an identity. The token store, the per-start admin secret, the socket `hello` check, the uplink join-token check and the HTTP request check live here and nowhere else.

## Rules

Strategies (ADR 0033):

- `authenticateRequest` asks the enabled strategies in registry order (`strategies/index.ts`): `token`, then `proxy`, so a good `slk_` token wins. The first answer other than `not-mine` ends the list, and the refusal's message and details come from the strategy.
- `not-mine` means the strategy's credential is absent. It is not a refusal: the next strategy is asked.
- `strategies/conformance.test.ts` runs every registered strategy: `not-mine` without its credential, `via` equal to its name.

The proxy strategy:

- With `header: authorization`, only a `Bearer` value that does not start `slk_` is its credential.
- A credential over `HEADER_MAX_LENGTH` (`strategies/proxy-jwt/index.ts`) is `malformed`, and nothing is fetched for it.
- A verified JWT with no person claims is `not-mine`, not a refusal.
- A refusal is one `warn` log line with the reason and jose's message, never the JWT.
- A proxy identity is `ambient` and carries `expiresAt`: http's cross-site check and the stream deadlines read them.
- `KeyCache` is ours, not jose's remote set, so it runs on the `Clock`.
- It fails closed: a failed fetch keeps the keys while they are younger than `KEY_KEEP_MS` (`strategies/proxy-jwt/key-cache.ts`); past that they are dropped and every proxy JWT is `keys-unavailable` until a fetch works.
- An unknown key id refetches at most once per `UNKNOWN_KEY_REFETCH_MS`, counted from the last good fetch.
- The fetch goes through the `KeySetFetcher` port, which never follows a redirect and caps the body.

Tokens and the uplink:

- A worker join token is `forbidden` on HTTP and accepted only by `authenticateUplink`.
- The claimed worker id is checked against the id alphabet before any pin, so `*`, `.`, `..` and an empty id never reach the store.
- A join token is pinned to the first worker id it is accepted with, and a worker id to one live token. Re-pairing is `token revoke` + `token create`.
- Every verify reads the `tokens` table, so a `token revoke` takes effect at once.
- `createAuth` takes the daemon's `SqliteDatabase`, never the state module.

Socket:

- At `hello`, no credential is `agent`. A credential that is neither an operator token nor the admin secret is `AdminAuthenticationFailedError`, never a quiet `agent`.
- The admin secret's hash lives in memory from construction; the plaintext is written to `admin.token` only by `persist`, which the daemon calls after the socket claim.

## Adding a strategy

1. A directory under `strategies/`, and one line in `strategies/index.ts`: its place in the list is its priority.
2. A fixture in `strategies/conformance.test.ts`.
3. If it owns a config key under `http`: the mirror in the contract's `configSchema`. `src/core/config.ts` validates and defaults the key from the definition.
