# Event bus

Does: post-commit business facts — ids, order, the in-memory ring. The durable history is [history](../history/AGENTS.md).
Entry: `index.ts` → `EventBus`, `EventMap`, `eventKey`.
Uses: ports. Never imports: core, leasing, drivers, gateway.
Catalog: [internal EVENTS.md](../../docs/internal/EVENTS.md) (rationale),
[events.mdx](../../website/src/content/docs/docs/reference/events.mdx) (user cut). Rules: [events.md](../../docs/internal/agent-rules/events.md).

## Files

| File       | Role                                                             |
| ---------- | ---------------------------------------------------------------- |
| `index.ts` | `EventMap` (every event and its payload), `EventBus`, `eventKey` |
| `order.ts` | `byTimeThenSeq`: the one reading order                           |

## How it works

1. **Emit** — `emit(event, payload, module)` stamps `id` (`evt_<id>`), `timestamp`
   (`Clock`) and the next `seq`, appends to the ring, then calls per-event subscribers and
   all-event subscribers, synchronously.
2. **Republish** — `republish(envelope)` keeps a relayed fact's `id` and `timestamp`; only
   `seq` is new. One caller: the gateway's `WorkerLink`.
3. **Isolate** — a throwing subscriber is logged (`EventBusLogger`; the daemon passes
   `logger.child("bus")`) and skipped. The emitter never sees it.
4. **Replay** — `replay({ sinceSeq, sinceTs })` from the ring, sorted by `byTimeThenSeq`.

## State and timers

| What      | Default     | Key                    |
| --------- | ----------- | ---------------------- |
| Ring size | 1000 events | `eventBuffer.capacity` |

- The ring is memory only; `seq` restarts at 1 every run. `id` survives restarts.
- Nothing here writes a file. A subscriber that does (the history) is wired by `src/daemon/main.ts`.

## Rules

- Names are `subject.past-tense-fact`. A fact, never a command.
- Emit only after the commit that made it true. Never a step of a transaction.
- Payloads are self-contained; change them additively only.
- `id` names an event everywhere (ring, history, push). `seq` only orders within one run.
- Every reader orders by `byTimeThenSeq`, not by arrival.

## Adding an event

1. `index.ts`: the name and its payload type in `EventMap`.
2. `index.test.ts`: the name in `EVENT_NAMES` (typed `Record<EventName, true>`).
3. A row in both `docs/internal/EVENTS.md` and the website's events reference — name,
   payload, emission point, status. A test fails when the internal catalog's names differ from
   `EVENT_NAMES`.
4. Emit it from the module that commits the change, after the commit.
