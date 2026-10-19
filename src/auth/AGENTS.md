# Auth

Does: turns a credential into an identity. The token store, the per-start admin secret, the socket `hello` check, the uplink join-token check and the HTTP request check live here and nowhere else.
Entry: `index.ts` → `createAuth(options)` → `Auth`; `testing.ts` (`createAuthWith`, `fakeAuth`, `tokenIdentity`).
Uses: ports, contract only (`auth-imports-little`).
Never imports: any other component.
Imported by: daemon (`src/daemon/main.ts`, `src/daemon/server.ts`, `src/daemon/dispatcher.ts`, `src/daemon/error-code.ts`), http, gateway (types), core (`src/core/config.ts` reads the strategy registry), agent-device (`Identity`).
Decision: [ADR 0033](../../docs/internal/adr/0033-a-sign-in-proxy-is-a-second-way-to-sign-in-and-auth-is-one-module.md).

## Files

| File                             | Role                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `index.ts`                       | `createAuth`, `Auth`, `AuthError`, `AdminAuthenticationFailedError`         |
| `identity.ts`                    | `Identity`: principal, name, role, via, expiry, ambient, sign-out URL       |
| `strategy.ts`                    | `AuthStrategyDefinition`, `AuthStrategy`, `StrategyAnswer`, `AuthConfig`    |
| `strategies/index.ts`            | The registry: ordered definitions (today `token`)                           |
| `strategies/token/index.ts`      | The Simlock token strategy: `Authorization: Bearer slk_…`                   |
| `strategies/conformance.test.ts` | Every registered strategy: `not-mine` without its credential, `via` = name  |
| `token-store.ts`                 | `TokenStore`: hashed tokens in `tokens.json`; re-reads the file per verify  |
| `admin-secret.ts`                | `AdminSecretManager`: per-start secret, `admin.token`                       |
| `hello.ts`                       | `SessionRoleResolver`, `resolveAgentRole`, `AdminAuthenticationFailedError` |
| `tokens.ts`                      | `TokenRole`, `TokenRecord`, `TokenOperations`                               |

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

## Facts

- A worker join token is `forbidden` on HTTP and accepted only by `authenticateUplink`.
- `tokens.json` is re-read on every verify, so `token create`/`revoke` from another process takes effect at once. Writes are serialised in `TokenStore`.
- The admin secret's hash lives in memory from construction; the plaintext is written to `admin.token` (0600, atomic) only by `persist`, after the socket claim.
