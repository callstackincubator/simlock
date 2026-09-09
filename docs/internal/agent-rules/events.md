# Agent rules: events

Rules for defining and emitting events on the daemon's event bus.

1. **Names are `subject.past-tense-fact`**, lowercase, dot-separated:
   `device.released`, `lease.expired`, `disk.pressure-detected`. The subject
   is the entity the fact is about, not the module that emitted it.
2. **Events are facts, never commands.** If the name reads as an instruction
   (`cleanup.run`, `device.delete`), it's a direct call wearing a costume —
   make it a function call instead. A command on a bus can't be found with
   go-to-definition.
3. **Emit post-commit only.** An event may only be published after the state
   change it describes is committed to the registry/lease table. Handlers
   must never observe uncommitted state.
4. **Never await handlers in a workflow.** Emitters fire-and-forget. If the
   lease path needs a result from another module, it calls that module
   directly (see architecture rule 5).
5. **Handler failures are isolated.** A throwing subscriber is logged and
   skipped for that event; it must never propagate into the emitter. Handlers
   must be safe to run in any order — ordering between subscribers is never
   load-bearing.
6. **Payloads are self-contained and stable.** Include the ids and fields a
   consumer needs (lease id, device id, reason, durations) so handlers don't
   have to query state that may have moved on. Treat payload shape as a
   public contract: additive changes only.
7. **Every event carries** `timestamp`, `event`, `payload`, and the emitting
   module, and is appended to the ring buffer (this powers `simlock events`
   and the audit trail).
8. **New events are documented in the same change.** Adding or modifying an
   event requires updating [../EVENTS.md](../EVENTS.md) — name, payload,
   emission point, status.
