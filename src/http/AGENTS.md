# HTTP frontend

Does: the network API — `/v1` routes, bearer token → session, SSE, lease-request resources, console files.
Entry: no index. `src/daemon/main.ts` takes `createHttpApp` (`app.ts`), `HttpGateway`
(`server.ts`).
Uses: auth, contract, daemon (`DispatchSession`, `classifyError`, `OwnerRoutedFacts`), leasing (errors),
bus, core (types), modules (types), ports. Never imports: drivers, gateway.
Surface: [remote-agents.mdx](../../website/src/content/docs/docs/using-devices/remote-agents.mdx), [console.mdx](../../website/src/content/docs/docs/worker/console.mdx).

## Files

| File                    | Role                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`                | Every `/v1` route, error boundary, request log line                                                                                            |
| `routes.ts`             | `declareRoute`: a route declaration plus its base error codes; `validationHook`                                                                |
| `route-declarations.ts` | The declared routes (`DECLARED_ROUTES`): System and Devices, with the lease and admin lists                                                    |
| `lease-declarations.ts` | The declared lease and lease-request routes (`LEASE_ROUTES`), their reply and SSE message schemas                                              |
| `admin-declarations.ts` | The declared worker, component, token and event routes (`ADMIN_ROUTES`), which side answers 501, install's and the event stream's SSE messages |
| `openapi.ts`            | `buildOpenApiDocument(modules)`: the OpenAPI 3.1 document                                                                                      |
| `module-routes.ts`      | `moduleRoutes`: the routes a module definition's `http` carries, as registrable paths                                                          |
| `auth.ts`               | `requireAuth`: asks `src/auth`, maps `AuthError` → 401/403                                                                                     |
| `dispatcher-session.ts` | `HttpDispatch`; `buildHttpSession`: identity → `DispatchSession`                                                                               |
| `tracker.ts`            | `LeaseRequestTracker`: lease requests as resources                                                                                             |
| `notices.ts`            | `LeaseNoticeBuffer`: per-lease health facts between polls                                                                                      |
| `output-relay.ts`       | `OutputRelay`: `device.exec` chunks onto one SSE response                                                                                      |
| `sse.ts`                | `pipeSse`: ordered writes, keepalive                                                                                                           |
| `errors.ts`             | `HttpApiError`, `mapError`: error → status and body                                                                                            |
| `server.ts`             | `HttpGateway` listener; `withConsole` serves the built `ui/`                                                                                   |
| `test-fakes.ts`         | Fakes for this module's tests                                                                                                                  |

## How a request runs

1. `withConsole` — `/v1` and `/v1/*` go to the app. Every other path is a console file,
   with CSP, `nosniff` and `no-referrer`; a page path (no extension, not `/assets/`)
   falls back to `index.html`. An unbuilt console answers 404 and logs one warning.
2. Log middleware — one `request` line per answer (method, path, status, `durationMs`,
   `requesterId`). Not for `/v1/healthz`.
   Inside it, a JSON `200` to a `GET` gets an `ETag`, and a matching `If-None-Match` turns it
   into `304` with no body. Streams and mounts are skipped, so their bodies are never read.
3. `requireAuth` on every route but `GET /v1/healthz`. It asks `src/auth` with the request's
   headers: a bearer token, or the JWT the sign-in proxy adds when `http.proxyAuth` is set.
   Neither valid → 401 `UNAUTHENTICATED`. A `worker` join token → 403 on every route.
   A proxy-signed (`ambient`) identity on any method but GET, HEAD or OPTIONS needs
   `Sec-Fetch-Site: same-origin` exactly, else 403 `FORBIDDEN` (mounts included). Tokens are exempt.
4. Input — a declared route's query, path and JSON body schemas run before the handler;
   a failure is 400 `BAD_REQUEST` (`validationHook`). A JSON body without a JSON content type is
   415 `UNSUPPORTED_MEDIA_TYPE`, malformed JSON 400 `Invalid JSON body` (`mapError` reads the
   library's `HTTPException`). Renew's body is optional: an empty body is read as none, whatever
   the content type, and `emptyBodyAsNone` says so before the validator.
5. `buildHttpSession` — principal = the identity's (a token's id, or `proxy:<iss>#<sub>`); `operator` → `admin`, `agent` → `agent`.
6. `deps.dispatch` — the daemon's own dispatcher, in process: `DaemonServer.dispatch`.
   Role check, `authorize` and readiness parking run there.
7. `app.onError` → `mapError` → `{ error: { code, message, ...details } }`. `NO_CAPACITY`
   adds `Retry-After: 5`. An unknown error answers `INTERNAL`, "Internal error", and is logged.

## Route declarations

`declareRoute` (`routes.ts`) wraps `createRoute`: a route states its method, path, tag, role, input
schemas, reply and its own error codes, and the helper adds the bearer requirement and the base
codes: `UNAUTHENTICATED` and `FORBIDDEN` (not on `/v1/healthz`), `DAEMON_STOPPING`,
`DAEMON_STARTUP_FAILED` and `INTERNAL` on every route, `BAD_REQUEST` on a route with any input,
`UNSUPPORTED_MEDIA_TYPE` on a route with a JSON body. `errorExtras` adds a status's body fields and headers (`capacityReason`, `Retry-After`). The code lists are documentation: nothing
enforces them. `app.openapi` registers the declaration, and a handler's JSON reply is type-checked
against it (never at run time; a stream, which declares `stream: sseMessage({...})`, or a bodiless 204 returns any `Response`). `route-declarations.ts` holds them, `buildOpenApiDocument` writes
the document from the same list plus the routes of every definition that carries `http` (`module-routes.ts`; the stream's, none for agent-device), and `pnpm openapi <file>` saves it. The route-coverage test in
`core-routes.test.ts` checks that every route the app serves is declared.

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
- `GET /v1/events` — reads `since`, `before` and `limit` through `eventsPageQuery` (contract), refused as 400 before dispatching `events.replay`; `HISTORY_NOT_KEPT` maps to 422 with `oldestTs`, `HISTORY_UNAVAILABLE` to 503 here too.
- `GET /v1/stats` — parses `since`/`from`/`to` with `usageWindow` (contract) and `ledger=1`, all refused as 400 before dispatching `usage.get` (the dispatcher answers an agent token 403, `HISTORY_NOT_KEPT` maps to 422 with `oldestTs`, `HISTORY_UNAVAILABLE` to 503).
- `POST /v1/update` (optional body `{version, force}`, strict) → `daemon.update`: 202 when the call began the update (`started`), 200 when it followed one or found nothing to do (`upToDate`). The route declares both (`alsoStatus`). The role check is the dispatcher's; on a gateway it updates the gateway itself, with no lease wait.
- `POST /v1/workers/{id}/update` (optional body `{version, force}`, strict) → `worker.update`: the same 202 and 200; `UNKNOWN_WORKER` 404, `WORKER_NOT_CONNECTED` 409, and a worker daemon answers 501.
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
- `tokens` table of `state.db`: `id` (`tok_…`), `hash`, `role`, `label` (NULL when absent), `created_at`.
  `src/auth` owns it: the dispatcher's `token.*` handlers write it through `Auth.tokens`,
  and every verify reads the table. The secret is shown once, by `token.create`.
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
  and its `/events` dispatch `lease.get` (`findOwnedLease`), which answers `UNKNOWN_LEASE` for a
  lease that is not there and for one the caller does not own alike.
  Renew and release dispatch directly and answer 403.
- **Error codes outside the contract union.** `UNAUTHENTICATED`, `UNKNOWN_LEASE_REQUEST`,
  `REQUEST_NOT_CANCELLABLE`, `REQUEST_CANCELLED` (`errors.ts`) have no `ERROR_TABLE` row, so
  a typed client sees `UNKNOWN_DAEMON_ERROR`.
