# 0013. The console reads the routes and follows the event stream

- **Status:** Proposed
- **Date:** 2026-10-02
- **Issue:** [#88](https://github.com/callstackincubator/simlock/issues/88)
- **Supersedes:** nothing.
- **Depends on:** [ADR 0011](0011-the-console-is-a-built-app-the-daemon-serves.md)
  and [ADR 0012](0012-a-worker-answers-the-fleet-operations-as-a-fleet-of-one.md).

## Context

#88 says changes appear within about a second, without a reload. When the
console loses the daemon, it says so, shows how old its data is, and
recovers by itself.

The daemon already has most of what the console needs. The read routes
answer from memory: the registry on a worker, the worker views on a gateway.
`GET /v1/events?since=` is the exception: it reads the event file.
`GET /v1/events/stream` sends every business event as Server-Sent Events,
with a keepalive every 15 seconds.

Events alone are not enough:

- A gateway republishes a worker's event first and refreshes that worker's
  view after. A read made the moment the event arrives can return the old
  view.
- Some facts change with no event. A worker that connects as
  `incompatible` emits none (ADR 0005). A worker's host facts change on the
  periodic refresh.

The same route can also answer different shapes in the two modes.
`GET /v1/devices` returns full device records on a worker and trimmed ones on
a gateway. The worker view has one shape in both modes.

## Decision

### 1. Which route feeds which view

| View | Route |
| --- | --- |
| Workers, a worker's devices, host facts and installs | `GET /v1/workers` |
| Leases, across the fleet and for one worker | `GET /v1/leases` |
| One lease's details | `GET /v1/leases/{id}` |
| Recent events | `GET /v1/events` and the stream (§2) |

Leases come from `GET /v1/leases`, not from the worker view. On a gateway,
that route gives a gateway-issued lease the id `GET /v1/leases/{id}` takes;
the view keeps the worker's own id. The console filters by `workerId` for
one worker. On a single host the leases carry no `workerId`, and all of them
belong to the one worker.

The console does not read `GET /v1/devices` or `GET /v1/status`. It keeps no
state the daemon does not report.

Waiting requests and the token label of a lease's holder have no route
today. #88's tasks add them. This ADR does not decide their shape.

### 2. One event stream, read with `fetch`

The console opens one connection to `GET /v1/events/stream`. It reads it
with `fetch` and a stream reader, so it can send the `Authorization`
header. It does not use `EventSource` or a WebSocket: a browser can send
that header with neither.

The events view fills like this:

1. Open the stream and hold what it sends.
2. Load the recent events with `GET /v1/events`.
3. Show both in time order, with each event once.

An event is the same event when its `seq` and `timestamp` both match. `seq`
alone is not enough: it starts again when the daemon restarts.

### 3. Events trigger a refetch, a poll covers the rest

- Any event refetches the routes the current screen reads, at once.
- The console also refetches them every second.
- Requests coalesce: at most one request per route is in flight. Calls that
  arrive while it runs cause one more request after it, not one each.
- Every request gives up after 10 seconds.

While the tab is hidden, polling stops and the stream is closed. When the
tab is shown again, the console refetches the screen, reopens the stream
and fills the events view as in §2. A browser allows only a few
connections to one host, and hidden tabs must not hold them.

### 4. Times count in the browser

Time to expiry, time in a state and time waited are computed in the browser
from the timestamps in the data. They tick every second with no request.

The browser's clock may differ from the daemon's. The console corrects for
it with the `Date` header of the latest response.

### 5. Losing the daemon

The console is disconnected when a request fails at the network level, when
a request gives up after 10 seconds, when the daemon closes the stream, or
when the stream sends nothing for 40 seconds, more than two keepalives.

While disconnected:

- It says so, keeps the last data on screen, and shows how old it is.
- Polling stops and the stream stays closed.
- It calls `GET /v1/healthz` after 1, 2, 4 and 8 seconds, then every 10
  seconds.

When `/v1/healthz` answers, the console refetches the screen, reopens the
stream and fills the events view as in §2. The fill asks
`GET /v1/events` for `since` set to how long it was disconnected, in whole
seconds, rounded up. While the daemon is still starting, its reads wait, so
the console says the daemon is starting until they answer.

## Consequences

- The existing routes and the stream do not change. The routes for waiting
  requests and holder labels are new work in #88's tasks.
- Each visible tab makes a few reads per second. They answer from memory,
  and on a gateway `GET /v1/workers` and `GET /v1/leases` answer from the
  views without asking a worker.
- A fact that changes with no event still shows within about a second.
- The stream gives the events view its order and timing. The poll gives the
  other views their correctness. A missed event costs at most one second.

## Alternatives considered

- **A WebSocket.** Rejected: a browser cannot send the `Authorization`
  header on one. The token would have to go in the URL or a subprotocol,
  where proxies and logs can see it. It would also be a second stream
  beside the SSE route that already exists.
- **`EventSource`.** Rejected: the same header problem.
- **Events only, no poll.** Rejected: see Context.
- **Refetch after each event, again one second later, and every 10
  seconds.** Less load. Rejected: an incompatible worker would take up to
  10 seconds to show.
- **The gateway publishes a worker's event only after the refresh it
  triggers, plus a new `worker.incompatible` event.** The cleanest promise
  for every client. Rejected for now: it narrows ADR 0005 and adds gateway
  work that only the console would use.
- **Keep the stream open in hidden tabs.** Rejected: a few hidden tabs would
  use up the browser's connections to the daemon.
