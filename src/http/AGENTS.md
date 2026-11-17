# HTTP frontend

Does: the network API — `/v1` routes, bearer token → session, SSE, lease-request resources, console files.
Surface: [remote-agents.mdx](../../website/src/content/docs/docs/using-devices/remote-agents.mdx), [console.mdx](../../website/src/content/docs/docs/worker/console.mdx).

## Rules

Dispatch:

- Never a second dispatcher and never the unix socket: `deps.dispatch` is the daemon's own dispatcher, called in process. Role check, `authorize` and readiness parking run there.
- No role or `authorize` check here. The exceptions: the cross-site check on a proxy-signed identity (`requireAuth`), the lease lookup of a module's lease route and of the lease file routes, and request ownership (`requireOwnRequest`): a stored request is read or cancelled by its owner or an operator, else 403.
- `app.ts` is a pure request → response function; the console lives in `server.ts`.
- Never imports drivers or gateway. No lint rule holds this.
- The listener starts right after the socket claim, before startup convergence. Early requests park in the dispatcher.

Auth and answers:

- `requireAuth` runs on every route but `GET /v1/healthz`, mounts and module lease routes included. Who the caller is, is `src/auth`'s answer; a `worker` join token gets 403 on every route.
- A proxy-signed (`ambient`) identity on any method but GET, HEAD or OPTIONS needs `Sec-Fetch-Site: same-origin` exactly, else 403 `FORBIDDEN`. So does a WebSocket upgrade. Tokens are exempt.
- A subscription stream (a request's events, a lease's events, the event stream) opened by an identity with `expiresAt` (a proxy JWT) ends then, and so does a screen stream (`stream/service.ts`). The exec and component-install streams take no deadline: they end with their command.
- No secret or hash in a body: `token.list`'s output schema has neither. The secret is shown once, by `token.create`.
- An error nothing recognizes answers `INTERNAL`, "Internal error", and is logged; its own message never leaves.
- The ETag step buffers a body to hash it, so it runs only on a JSON answer under `/v1` that is not a mount's. A stream's or a mount's body is never read.
- `emptyBodyAsNone` runs before the validator on a route whose body is optional: an empty body is read as none, whatever the content type.

Route declarations:

- A route's error code lists are documentation: nothing enforces them.
- A handler's JSON reply is type-checked against its declaration, never at run time. A stream or a bodiless 204 returns any `Response`.
- `buildOpenApiDocument` writes the document from the same declarations, plus the routes of every module definition that carries `http`. `core-routes.test.ts` checks that every route the app serves is declared, and that its first path segment is in the contract's `CORE_ROUTE_SEGMENTS`, which a module's name may not start with.
- A module's lease route (`HttpLeaseRoute`) gets the lease already resolved with `lease.get`: the owner or an operator; anyone else, and an unknown id, get 404 `UNKNOWN_LEASE`. The module never checks an owner, and http knows a module only by its name.
- A WebSocket upgrade of a lease route goes through `app.leaseSocket`, which runs the same auth and lease resolution, then the route's `socket.open`. A route with no `socket` answers 404 to an upgrade.

Lease requests:

- The record is the daemon's (`LeaseRequestReader`: a worker's request book or a gateway's coordinator), read through `leaseRequestRecordSchema`. `LeaseRequestTracker` stores none.
- `POST /v1/lease-requests` answers 201 once the daemon has stored the request and then reported progress or granted. It answers at once on admission for `allowDownload` (not on a gateway: `answerDownloadsEarly`) and for a replayed request. A rejection before that fails the `POST`.
- A request's event stream ends at a terminal stage, or at once when nothing in this process drives it.

Streams:

- The exec and component-install streams open on `onStarted`; a failure before that is a plain error response.
- `OutputRelay`: the write promise is the backpressure. Once the client is gone the command runs on and nothing is kept (`OutputRelay.bufferedCount` is asserted).
- `LeaseNoticeBuffer` takes the lease's health facts from the daemon's `OwnerRoutedFacts`, pushes them live to SSE listeners and keeps them until the lease's renew drains them into `notices`. `lease_lost` clears the lease.

## Known gaps

- **The notice buffer is the last frontend-held state.** It is in memory and resets on a daemon restart, so a polling client loses the health facts it had not drained. It needs a durable record of why a lease ended first.
- **Single-lease reads answer 404, not 403, for an unowned lease.** `GET /v1/leases/{id}` and its `/events` dispatch `lease.get`, which answers `UNKNOWN_LEASE` for a lease that is not there and for one the caller does not own alike. Renew and release dispatch directly and answer 403.
- **Error codes outside the contract union.** `UNAUTHENTICATED`, `UNKNOWN_LEASE_REQUEST`, `REQUEST_NOT_CANCELLABLE`, `REQUEST_CANCELLED` (`errors.ts`) have no `ERROR_TABLE` row, so a typed client sees `UNKNOWN_DAEMON_ERROR`.
