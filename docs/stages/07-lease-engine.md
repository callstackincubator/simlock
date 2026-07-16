# Stage 07 — Lease engine

Goal: the heart of pitlane — request → queue → provision → ready → grant,
release → reclaim, TTL backstop. Pure core logic tested exclusively with
FakeDriver + FakeClock + MemoryFilesystem. This stage has the most tests;
budget accordingly.

## Implement (in `src/core/`)

- **LeaseEngine** with the transactional flow (explicit call chain — emits
  events, never waits on them; agent-rules/architecture.md rule 5):
  1. `request(req, {requesterId, mode, timeoutMs?, noWait?, allowDownload})`
     → resolveSpec → try in order: free `ready` device matching spec →
     `warm` device (reclaim→ready) → provision new if `canProvision` →
     else queue (FIFO) or reject (noWait) → when a device is obtained:
     makeReady if needed → create LeaseRecord → grant.
  2. `release(leaseId, reason)` → transition leased→reclaiming →
     `driver.reclaim` → ready (then immediately serve the queue head) or
     shutdown per driver return.
  3. `renew(leaseId, ttlMs)` — detached mode only.
  4. TTL backstop: held leases get `heldTtlBackstopMs`, detached get
     `detachedTtlMs`; expiry = forced release with reason 'expired'
     (Clock timers; re-armed on renew).
- **Reservation discipline**: a device being provisioned/reclaimed/booted for
  a request is not visible to other requests (the state machine's
  `provisioning`/`reclaiming` states are the locks). Engine decisions are
  serialized through a single async queue — no interleaved decision-making —
  but driver operations run outside the decision lock (never hold it across
  await of a driver call).
- **One lease per requester** (v1): second `request` from the same
  requesterId is rejected with a typed error.
- Emits per docs/EVENTS.md: `lease.requested/queued/granted/renewed/released/
expired/rejected`, and drives registry transitions that emit `device.*`.
- Failure paths: provision fails → device → deleted, request re-enters
  decision loop (may queue); makeReady fails → destroy device, propagate
  `BootTimeoutError` to the requester.

## Tests first (the core scenarios; all deterministic via FakeClock)

- Grant an existing free ready device; spec mismatch does not match.
- No free device + capacity available → provisions, boots, grants; progress
  estimates surfaced (grant result includes device + timing info).
- At capacity → queued; FIFO order preserved across 3 waiters.
- `release` wakes exactly the queue head; reclaimed-to-ready device is
  reused, not re-provisioned.
- `noWait` at capacity → immediate typed rejection.
- Queue timeout → typed rejection, waiter removed (later release skips it).
- TTL expiry auto-releases and serves the queue; renew extends detached TTL;
  renew on held lease → error.
- One-lease-per-requester enforced; after release the requester can lease
  again.
- Provision failure → request either gets next capacity slot or queues;
  failed device ends `deleted`; no capacity leak (assert canProvision counts).
- Concurrency: two simultaneous requests, one device's worth of capacity →
  exactly one provision happens (reservation discipline).
- Event order for the happy path matches EVENTS.md semantics
  (requested → granted; device.provisioned → device.ready → lease.granted).

## Watch out

- The single-decision-queue serialization is the linchpin — a data race here
  is the tool failing at its one job. Write the two-simultaneous-requests
  test FIRST and make it fail before fixing.
- Don't leak timers: released/expired leases must cancel their backstop
  (FakeClock can assert no pending timers at test end).
- Requester identity is an opaque string supplied by the caller (the daemon
  will pass connection identity in stage 09).

## Acceptance criteria

- [ ] All scenarios above tested and green, using only fakes.
- [ ] No driver call is made while holding the decision lock.
- [ ] Events emitted match docs/EVENTS.md (update payload details there if
      refined — additively).
- [ ] `pnpm check` green.
