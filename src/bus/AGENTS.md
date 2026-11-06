# Event bus

Does: post-commit business facts — ids, order, the in-memory ring. The durable history is [history](../history/AGENTS.md).
Surface: [events.mdx](../../website/src/content/docs/docs/reference/events.mdx) — every event and its payload; [internal EVENTS.md](../../docs/internal/EVENTS.md) — rationale; [events.md](../../docs/internal/agent-rules/events.md) — the rules.

## Rules

- Names are `subject.past-tense-fact`. A fact, never a command.
- Emit only after the commit that made it true. Never a step of a transaction.
- Payloads are self-contained; change them additively only.
- `id` names an event everywhere (ring, history, push) and survives restarts. `seq` only orders within one run: it starts again with every run.
- `republish` keeps a relayed fact's `id` and `timestamp`; only `seq` is new.
- Every reader orders by `timestamp`, then `seq` (`byTimeThenSeq`; the history's SQL reads do the same), never by arrival: a relayed event carries the time it happened on the worker.
- Subscribers run synchronously inside `emit`. A throwing subscriber is logged and skipped; the emitter never sees it.
- The ring is memory only, and nothing here writes a file. A subscriber that does (the history) is wired by `src/daemon/main.ts`.
- Never imports core, leasing, drivers or gateway.

## Adding an event

1. `index.ts`: the name and its payload type in `EventMap`.
2. `index.test.ts`: the name in `EVENT_NAMES` (typed `Record<EventName, true>`).
3. A row in both `docs/internal/EVENTS.md` and the website's events reference — name,
   payload, emission point, status. A test fails when either catalog's names differ from
   `EVENT_NAMES`.
4. Emit it from the module that commits the change, after the commit.
