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

The daemon already has what the console needs. The read routes answer from
memory: the registry on a worker, the worker views on a gateway.
`GET /v1/events/stream` sends every business event as Server-Sent Events,
with a keepalive every 15 seconds.

Events alone are not enough:

- A gateway republishes a worker's event first and refreshes that worker's
  view after. A read made the moment the event arrives can return the old
  view.
- Some facts change with no event. A worker that connects as
  `incompatible` emits none (ADR 0005). A worker's host facts change on the
  periodic refresh.

## Decision

### 1. Data comes from the read routes

Every view loads from the existing `/v1` read routes, plus any route a
task adds for #88. The console keeps no state the daemon does not report.

### 2. One event stream, read with `fetch`

The console opens one connection to `GET /v1/events/stream`. It reads it
with `fetch` and a stream reader, so it can send the `Authorization`
header. It does not use `EventSource` or a WebSocket: a browser can send
that header with neither.

The events view shows the stream's events as they arrive, after the recent
ones from `GET /v1/events`.

### 3. Events trigger a refetch, a poll covers the rest

- Any event refetches the routes the current screen reads, at once.
- The console also refetches them every second.
- Requests coalesce: at most one request per route is in flight. Calls that
  arrive while it runs cause one more request after it, not one each.
- Polling stops while the tab is hidden and starts again when it is shown.

### 4. Times count in the browser

Time to expiry, time in a state and time waited are computed in the browser
from the timestamps in the data. They tick every second with no request.

### 5. Losing the daemon

The console is disconnected when a request fails at the network level, or
when the stream sends nothing for 40 seconds, more than two keepalives.

While disconnected, it says so, keeps the last data on screen, and shows
how old it is. It retries after 1, 2, 4 and 8 seconds, then every 10
seconds.

When a request succeeds again, it refetches the screen and reopens the
stream. It fills the gap in the events view from `GET /v1/events`, with
`since` set to how long it was disconnected.

## Consequences

- No daemon change. The console works with the routes and stream that exist.
- Each open tab makes a few reads per second. They answer from memory, and
  on a gateway the list routes answer from the views without asking a
  worker.
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
