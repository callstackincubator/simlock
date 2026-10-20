# HTTP frontend

Does: the network API — `/v1` routes, bearer token → session, SSE, lease-request resources, console files.
Entry: no index. `src/daemon/main.ts` takes `createHttpApp` (`app.ts`), `HttpGateway`
(`server.ts`).
Uses: auth, contract, daemon (`DispatchSession`, `classifyError`, `OwnerRoutedFacts`), leasing (errors),
bus, core (types), ports. Never imports: drivers, gateway.
Surface: [HTTP-API.md](../../docs/HTTP-API.md), [CONSOLE.md](../../docs/CONSOLE.md).

## Files

| File                    | Role                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `app.ts`                | Every `/v1` route, error boundary, request log line              |
| `auth.ts`               | `requireAuth`: asks `src/auth`, maps `AuthError` → 401/403       |
| `dispatcher-session.ts` | `HttpDispatch`; `buildHttpSession`: identity → `DispatchSession` |
| `tracker.ts`            | `LeaseRequestTracker`: lease requests as resources               |
| `notices.ts`            | `LeaseNoticeBuffer`: per-lease health facts between polls        |
| `output-relay.ts`       | `OutputRelay`: `device.exec` chunks onto one SSE response        |
| `sse.ts`                | `pipeSse`: ordered writes, keepalive                             |
| `errors.ts`             | `HttpApiError`, `mapError`: error → status and body              |
| `server.ts`             | `HttpGateway` listener; `withConsole` serves the built `ui/`     |
| `test-fakes.ts`         | Fakes for this module's tests                                    |

## How a request runs

1. `withConsole` — `/v1` and `/v1/*` go to the app. Every other path is a console file,
   with CSP, `nosniff` and `no-referrer`; a page path (no extension, not `/assets/`)
   falls back to `index.html`. An unbuilt console answers 404 and logs one warning.
2. Log middleware — one `request` line per answer (method, path, status, `durationMs`,
   `requesterId`). Not for `/v1/healthz`.
3. `requireAuth` on every route but `GET /v1/healthz`. It asks `src/auth` with the request's
   headers: a bearer token, or the JWT the sign-in proxy adds when `http.proxyAuth` is set.
   Neither valid → 401 `UNAUTHENTICATED`. A `worker` join token → 403 on every route.
   A proxy-signed (`ambient`) identity on any method but GET, HEAD or OPTIONS needs
   `Sec-Fetch-Site: same-origin` exactly, else 403 `FORBIDDEN` (mounts included). Tokens are exempt.
4. Body — strict zod schema (`jsonBody`), else 400 `BAD_REQUEST`.
5. `buildHttpSession` — principal = the identity's (a token's id, or `proxy:<iss>#<sub>`); `operator` → `admin`, `agent` → `agent`.
6. `deps.dispatch` — the daemon's own dispatcher, in process: `DaemonServer.dispatch`.
   Role check, `authorize` and readiness parking run there.
7. `app.onError` → `mapError` → `{ error: { code, message, ...details } }`. `NO_CAPACITY`
   adds `Retry-After: 5`. An unknown error answers `INTERNAL`, "Internal error", and is logged.

`HttpMount` adds a prefix (`/v1/<prefix>`, `/v1/<prefix>/*`) behind the same auth. Today: the
agent-device front and the stream (`/v1/stream`).

## Lease requests

1. `POST /v1/lease-requests` → `LeaseRequestTracker.submit` → `lease.request`.
   `Idempotency-Key` header → `idempotencyKey`.
2. Answers 201 when the daemon has stored the request and then reports progress or grants.
   At once on admission for `allowDownload` (not on a gateway: `answerDownloadsEarly: false`)
   and for a replayed request. A rejection before that fails the `POST`.
3. The record is the daemon's (`LeaseRequestReader`: a worker's request book or a gateway's
   coordinator), read through `leaseRequestRecordSchema`. The tracker stores none.
4. `GET .../{id}?wait=<s>` long-polls, capped at 60 s. `GET .../{id}/events` streams each
   stage; ends at a terminal stage, or at once when nothing in this process drives it.
5. `DELETE .../{id}` → `lease.cancel` → 204, or 409 `REQUEST_NOT_CANCELLABLE`.
6. Reading or cancelling a request: its owner or an operator, else 403 (`requireOwnRequest`).

## Streams

- `pipeSse` writes events in order, `: keepalive` every 15 s, unsubscribes on abort. A stream
  opened by an identity with `expiresAt` (a proxy JWT) ends then (`sse.ts`, `app.ts`).
- `GET /v1/events/stream` — dispatches `events.subscribe` (admin, readiness), then
  subscribes to the `EventBus` itself.
- `GET /v1/stats` — parses `since`/`from`/`to` with `usageWindow` (contract) and `ledger=1`, all refused as 400 before dispatching `usage.get` (the dispatcher answers an agent token 403, `HISTORY_NOT_KEPT` maps to 422 with `oldestTs`, `HISTORY_UNAVAILABLE` to 503).
- `GET /v1/leases/{id}/events` — the lease's notices; ends on `lease_lost`.
- `POST /v1/leases/{id}/exec` → `device.exec`. The stream opens on `onStarted`; a failure
  before that is a plain error response. Events: `output`, then `exit` or `error`.
- `POST /v1/components/install` → `component.install`, or `worker.install-component` with
  `workers`. Events: `progress`, then `result` or `error`.

`OutputRelay` states: starting (chunk held; its `push` promise resolves once flushed),
streaming (straight to the wire; the write promise is the backpressure), dropped (client
gone; the command runs on; nothing is kept).

`LeaseNoticeBuffer` takes `device_unhealthy`, `device_recovered` and `lease_lost` from the
daemon's `OwnerRoutedFacts`, per lease. It pushes live to SSE listeners and keeps them
until `POST /v1/leases/{id}/renew` drains them into `notices`. `lease_lost` clears the lease.

## State and timers

| What                        | Default                                               | Key                      |
| --------------------------- | ----------------------------------------------------- | ------------------------ |
| Listener on/off             | off on a worker, on on a gateway                      | `http.enabled`           |
| Address                     | `127.0.0.1`, port 4701 on a worker, 4700 on a gateway | `http.host`, `http.port` |
| SSE keepalive               | 15 s                                                  | fixed, `sse.ts`          |
| Long-poll cap               | 60 s                                                  | fixed, `app.ts`          |
| `NO_CAPACITY` `Retry-After` | 5 s                                                   | fixed, `errors.ts`       |

- The listener starts right after the socket claim (`onSocketClaimed`), before startup
  convergence. Early requests park in the dispatcher. On a gateway the worker uplink
  upgrades on the same listener (`onServerCreated`).
- `tokens.json` (data directory): `{ id: "tok_…", hash, role, label?, createdAt }`, written
  atomically, mode `0600`. `src/auth` owns it: the dispatcher's `token.*` handlers write it through `Auth.tokens`,
  and every verify re-reads the file. The secret is shown once, by `token.create`.
- `LeaseNoticeBuffer` is memory only. `HttpGateway.stop` closes the server and destroys
  every open socket.

## Rules

- No role or `authorize` check here; the shared dispatcher runs them. Two exceptions:
  `worker` tokens (`requireAuth`) and request ownership (`requireOwnRequest`).
- Never a second dispatcher and never the unix socket: the same object, called in process.
- `app.ts` is a pure request → response function; the console lives in `server.ts`.
- No secret or hash in a body: `token.list`'s output schema has neither.
- Nothing is kept after an exec client disconnects (`OutputRelay.bufferedCount` is asserted).

## Known gaps

- **The notice buffer is the last frontend-held state.** It is in memory and resets on a
  daemon restart, so a polling client loses the health facts it had not drained. It needs
  a durable record of why a lease ended first.
- **Single-lease reads answer 404, not 403, for an unowned lease.** `GET /v1/leases/{id}`
  and its `/events` filter `lease.list` (`findOwnedLease`); there is no `lease.get`.
  Renew and release dispatch directly and answer 403.
- **Error codes outside the contract union.** `UNAUTHENTICATED`, `UNKNOWN_LEASE_REQUEST`,
  `REQUEST_NOT_CANCELLABLE`, `REQUEST_CANCELLED` (`errors.ts`) have no `ERROR_TABLE` row, so
  a typed client sees `UNKNOWN_DAEMON_ERROR`.
