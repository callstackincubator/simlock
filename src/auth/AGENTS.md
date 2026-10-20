# Auth

Does: turns a credential into an identity. The token store, the per-start admin secret, the socket `hello` check, the uplink join-token check and the HTTP request check live here and nowhere else.
Entry: `index.ts` → `createAuth(options)` → `Auth`; `testing.ts` (`createAuthWith`, `fakeAuth`, `tokenIdentity`).
Uses: ports, contract only, jose (`auth-imports-little`).
Never imports: any other component.
Imported by: daemon (`src/daemon/main.ts`, `src/daemon/server.ts`, `src/daemon/dispatcher.ts`, `src/daemon/error-code.ts`), http, gateway (types), core (`src/core/config.ts` reads the strategy registry), agent-device (`Identity`).
Decision: [ADR 0033](../../docs/internal/adr/0033-a-sign-in-proxy-is-a-second-way-to-sign-in-and-auth-is-one-module.md).

## Files

| File                                | Role                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `index.ts`                          | `createAuth`, `Auth`, `AuthError`, `AdminAuthenticationFailedError`                                      |
| `identity.ts`                       | `Identity`: principal, name, role, via, expiry, ambient, sign-out URL                                    |
| `strategy.ts`                       | `AuthStrategyDefinition`, `AuthStrategy`, `StrategyAnswer`, `AuthConfig`                                 |
| `strategies/index.ts`               | The registry: ordered definitions (`token`, then `proxy`)                                                |
| `strategies/token/index.ts`         | The Simlock token strategy: `Authorization: Bearer slk_…`                                                |
| `strategies/proxy-jwt/index.ts`     | The proxy strategy: a sign-in proxy's JWT in `http.proxyAuth.header`; owns the `proxyAuth` config schema |
| `strategies/proxy-jwt/key-cache.ts` | `KeyCache`: the proxy's published keys, on the `Clock`                                                   |
| `strategies/conformance.test.ts`    | Every registered strategy: `not-mine` without its credential, `via` = name                               |
| `token-store.ts`                    | `TokenStore`: hashed tokens in the `tokens` table of `state.db`; one read per verify; `tokensOwner`      |
| `admin-secret.ts`                   | `AdminSecretManager`: per-start secret, `admin.token`                                                    |
| `hello.ts`                          | `SessionRoleResolver`, `resolveAgentRole`, `AdminAuthenticationFailedError`                              |
| `tokens.ts`                         | `TokenRole`, `TokenRecord`, `TokenOperations`                                                            |

## Auth

| Member                | Does                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `authenticateRequest` | Asks the enabled strategies in registry order; returns `Identity` or throws `AuthError`                  |
| `resolveHelloRole`    | No credential → `agent`; operator token or admin secret → `admin`; else `AdminAuthenticationFailedError` |
| `authenticateUplink`  | None or unknown → `unauthenticated`; not a `worker` token → `forbidden`; else accept with the token id   |
| `tokens`              | `create`, `list`, `revoke` (both dispatchers)                                                            |
| `adminSecret`         | `persist`, `remove` (`DaemonServer`)                                                                     |

## Strategies

A strategy answers `identified`, `not-mine` (its credential is absent; `sawCredential` when an
unclaimed bearer value was present), `rejected` (401) or `forbidden` (403). The first answer other
than `not-mine` ends the list, and the refusal's message and details come from the strategy.
When all answer `not-mine`: 401 "Unknown bearer token" if any saw a credential, else "Missing
bearer token". Adding one: a directory under `strategies/` with its `testing.ts` fixture, one line
in `strategies/index.ts`, and (if it owns a config key under `http`) the mirror in the contract's
`configSchema`; `src/core/config.ts` validates and defaults the key from the definition.

## The proxy strategy

Enabled when `http.proxyAuth` is set; after `token`, so a good `slk_` token wins. No configured
header → `not-mine` (with `header: authorization`, only a `Bearer` value not starting `slk_` is
its credential). A value over 8 KiB is `malformed` and nothing is fetched. Otherwise `jwtVerify`
(RS256, ES256, issuer, audience, 60 s tolerance, `exp` required) against the key cache's set. A
person (`sub` non-empty and at most 120 characters, `email` non-empty) is `identified`:
`proxy:<iss>#<sub>`, role `operator`, `via` `proxy`, `expiresAt` = `exp`×1000 + 60 s, `ambient`.
A verified JWT with no person claims is `not-mine`. Anything else is `rejected` "Sign-in proxy
identity refused: <reason>" with `details.reason` (the nine reasons are in `docs/HTTP-API.md`),
and one `warn` log line with the reason and jose's message, never the JWT.

`KeyCache` is ours, not jose's remote set, so it runs on the `Clock`: keys are kept 10 minutes
from a good fetch; a fetch is cut off at 5 s by a `Clock` timer; an unknown key id refetches at
most once per 30 s from the last good fetch; one fetch is in flight at a time and every waiting
request shares it. A failed fetch keeps keys under 10 minutes old; past that they are dropped and
every proxy JWT is `keys-unavailable` until a fetch works (fails closed). The fetch goes through
the `KeySetFetcher` port, which never follows a redirect and caps the body at 64 KiB.

## Facts

- A worker join token is `forbidden` on HTTP and accepted only by `authenticateUplink`.
- Every verify reads the `tokens` table, so a `token revoke` takes effect at once. `create` and `revoke` are each one transaction, so two at once never lose one another. `createAuth` takes the daemon's `SqliteDatabase`, never the state module.
- The admin secret's hash lives in memory from construction; the plaintext is written to `admin.token` (0600, atomic) only by `persist`, after the socket claim.
