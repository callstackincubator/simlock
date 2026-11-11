# 0074. An admission command ranks or refuses a gateway request, and an ended chosen lease id is remembered

- **Status:** Accepted — not yet implemented
- **Date:** 2026-11-10
- **Issue:** [#1516](https://github.com/callstackincubator/simlock/issues/1516) (request [#1406](https://github.com/callstackincubator/simlock/issues/1406))
- **Narrows:** [ADR 0005](0005-gateway-and-worker-modes.md) items 10 and 11 ("one gateway-side FIFO queue", "each queued request, oldest first"): with an admission command set, a gateway line is ordered by priority, then by arrival.
- **Supersedes in part:** [ADR 0020](0020-a-requester-may-choose-its-lease-id.md) §1 ("It keeps no record of ids that were used"): an ended chosen id is kept for a window.

## Context

Teams put Simlock behind their own scheduler: a coordinator that owns
budgets, roles and priorities for many resources, devices among them. The
coordinator can already refuse a request before it sends it. What it cannot
do is order the requests that wait in the gateway's queue, which serves the
oldest first. Today it keeps its order only by sending every request with
`noWait` and retrying from its side. That loses the gateway's queue, its
progress pushes, and a freed device to whoever polls first.

The same coordinator maps its own retry key to a lease id it chooses
(ADR 0020). While the lease lives, a retry gets `LEASE_ID_TAKEN`. After the
lease ends, Simlock forgets the id, so a late retry is granted a new device
for a job that already ran.

## Decision

### 1. An operator's admission command ranks or refuses each new gateway request

A gateway may name an admission command: `gateway.admission.command`, an
argv list such as `["bun", "/etc/simlock/policy.ts"]`. Simlock runs it as a
child process, so the policy can be written for any runtime or none.

```mermaid
sequenceDiagram
  participant C as caller
  participant G as gateway
  participant P as admission command
  C->>G: lease.request
  G->>G: replay? answer as today
  G->>P: spawn; one JSON object on stdin
  alt {"priority": n} or {}
    P-->>G: exit 0, JSON on stdout
    G->>G: admission checks as today, then queue at priority n
    G-->>C: queued / granted
  else {"deny": "reason"}
    P-->>G: exit 0
    G-->>C: ADMISSION_DENIED, reason
  else non-zero exit, bad JSON, time limit, too much output
    G-->>C: ADMISSION_FAILED
  end
```

- It runs once per new request, after today's cheap refusals and before
  the request is stored: a request the gateway already holds is answered
  as today, and the requester limit, a taken chosen id and an ended one
  (§4) are refused without running it. It runs outside the gateway's
  decision lock, so a slow command delays only its own request; after it
  answers, those checks run again under the lock before the request is
  stored, so two copies of one request are never both admitted.
- It reads one JSON object on stdin: the requester, the principal, the
  platform, the `lease.request` input as the caller sent it (without
  `metadata`, the requester and the idempotency key) and the caller's
  `metadata` (§3). It
  prints one JSON object: `{"priority": <integer -1000..1000>}`, `{}`
  (priority 0) or `{"deny": "<reason>"}`.
- **It fails closed.** A non-zero exit, output that is not one such object,
  more output than the limit, or running past `gateway.admission.timeoutMs`
  refuses the request with `ADMISSION_FAILED`. A budget is never skipped
  because the policy is broken.
- No command set: every request has priority 0, and the queue is as today.

### 2. A gateway line is ordered by priority, then by arrival

The gateway keeps its lines (virtual and physical devices wait apart).
Within a line, a higher priority is served first; equal priorities keep
arrival order, and the queue position a waiter is told follows that
order. A request's priority is fixed when it is admitted. A
low-priority request can wait until its own queue timeout. A worker's own
queue does not change.

### 3. A lease request may carry metadata for the command

`lease.request` takes an optional `metadata` object of short text values,
such as `{"project": "checkout-app", "role": "ci"}`. It goes to the
admission command only: it is not stored, not put in any event and not
forwarded to a worker. A worker accepts and ignores it, so one client works
against both.

### 4. An ended chosen lease id is remembered for a window

When a lease whose id the requester chose ends, however it ends, the
daemon that held it keeps the id and the time it ended in `state.db` for
`lease.endedIdRetentionMs` (default 24 hours). A `lease.request` naming
such an id is refused with `LEASE_ENDED`, carrying the id and when it
ended. A worker records its own leases; a gateway records the ids of its
leases it learns ended from its workers: a relayed end, its own release,
or a lease its worker's views stop listing. A worker the gateway forgets
records nothing, since its leases may still be live. A lease that ends while its
gateway is down is not recorded by the gateway: a retry through it is
answered `LEASE_ENDED` only when routing sends it to the worker that held
the lease. This is a known gap, chosen over persisting every live chosen id
on the gateway. A generated id is never recorded:
it never comes back. After the window the id is forgotten, and ADR 0020's
rule holds again: the requester keeps its ids unique.

## Alternatives

- **A blocking HTTP policy called before queueing and before every
  dispatch.** Most control (allow, deny, defer), but every grant would wait
  on an outside service, and "the service is down" would need its own
  rules. A coordinator that changes its mind cancels its request instead.
- **A priority field the caller sets.** No command to run, but any caller
  could raise its own priority; the operator's command is the one place
  that decides it.
- **Loading a JavaScript module inside the gateway.** Fastest, but ties the
  policy to Node-compatible JavaScript, and a hang or throw lives in the
  gateway.
- **Remembering ended ids in memory only.** Smaller, but a late retry right
  after a daemon restart, the likeliest moment for retries, would get a new
  device.

## Consequences

- New config keys: `gateway.admission.command`,
  `gateway.admission.timeoutMs` (gateway) and `lease.endedIdRetentionMs`
  (both roles).
- New error codes `ADMISSION_DENIED` (403), `ADMISSION_FAILED` (503) and
  `LEASE_ENDED` (409), and new `lease.rejected` reasons; the protocol is
  bumped. The CLI gets a new exit code 16 for the two admission codes;
  `LEASE_ENDED` exits 13, beside `LEASE_ID_TAKEN`.
- A gateway runs one child process per new request while a command is set:
  about a tenth of a second each on a Mac.
- A gateway's line order is no longer FIFO when a command answers
  priorities; the routing docs say so.
- Ended chosen ids cost one small `state.db` table per daemon, pruned by
  age.
