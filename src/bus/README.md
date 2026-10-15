# Event bus

Does: post-commit business facts — ids, order, the in-memory ring, the event file.
Entry: `index.ts` → `EventBus`, `EventMap`, `EventHistory` and the event-file readers.
Uses: contract (`EVENT_ID_PATTERN`), ports. Never imports: core, leasing, drivers, gateway.
Catalog: [internal EVENTS.md](../../docs/internal/EVENTS.md) (rationale),
[EVENTS.md](../../docs/EVENTS.md) (user cut). Rules: [events.md](../../docs/internal/agent-rules/events.md).

## Files

| File            | Role                                                            |
| --------------- | --------------------------------------------------------------- |
| `index.ts`      | `EventMap` (every event and its payload), `EventBus`            |
| `event-file.ts` | `EventHistory`, `readEventFile`, `readEventHistory`, `eventKey` |
| `order.ts`      | `byTimeThenSeq`: the one reading order                          |

## How it works

1. **Emit** — `emit(event, payload, module)` stamps `id` (`evt_<id>`), `timestamp`
   (`Clock`) and the next `seq`, appends to the ring, then calls per-event subscribers and
   all-event subscribers, synchronously.
2. **Republish** — `republish(envelope)` keeps a relayed fact's `id` and `timestamp`; only
   `seq` is new. One caller: the gateway's `WorkerLink`.
3. **Isolate** — a throwing subscriber is logged (`EventBusLogger`; the daemon passes
   `logger.child("bus")`) and skipped. The emitter never sees it.
4. **Replay** — `replay({ sinceSeq, sinceTs })` from the ring, sorted by `byTimeThenSeq`.
5. **Write** — `EventHistory` subscribes to all events and writes each envelope as one JSON
   line through a `LogSink` to `events.jsonl`. A write that throws is logged once and
   writing stops; the emitter is untouched.
6. **Read back** — `EventHistory.replay`: no `sinceTs` → the ring. With `sinceTs` → the
   file: current, then `.1`, `.2`, … until two in a row are missing; deduplicated by `id`;
   sorted. No file, or a failed read → the ring.

## State and timers

| What                     | Default     | Key                                              |
| ------------------------ | ----------- | ------------------------------------------------ |
| Ring size                | 1000 events | `eventBuffer.capacity`                           |
| Rotate the event file at | 5 MiB       | `eventLog.rotateBytes`                           |
| Keep generations for     | 7 days      | `eventLog.retention`                             |
| Total size cap           | 256 MiB     | `eventLog.maxBytes` (at least 2 × `rotateBytes`) |

- The ring is memory only; `seq` restarts at 1 every run. `id` survives restarts.
- The sink is opened in `src/daemon/main.ts` (`openEventHistory`). It fails open: no
  file means memory only, and one error line.
- Readers: `events.replay` in both dispatchers; the CLI's `events --since` when no daemon
  answers. A gateway's file also holds the relayed fleet events.

## Rules

- Names are `subject.past-tense-fact`. A fact, never a command.
- Emit only after the commit that made it true. Never a step of a transaction.
- Payloads are self-contained; change them additively only.
- `id` names an event everywhere (ring, file, push). `seq` only orders within one run.
- Every reader orders by `byTimeThenSeq`, not by arrival.

## Adding an event

1. `index.ts`: the name and its payload type in `EventMap`.
2. `index.test.ts`: the name in `EVENT_NAMES` (typed `Record<EventName, true>`).
3. A row in both `docs/internal/EVENTS.md` and `docs/EVENTS.md` — name, payload, emission
   point, status. A test fails when either catalog's names differ from `EVENT_NAMES`.
4. Emit it from the module that commits the change, after the commit.
