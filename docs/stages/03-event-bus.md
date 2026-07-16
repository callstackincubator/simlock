# Stage 03 — Event bus

Goal: the in-process typed event bus per ARCHITECTURE.md "Event bus" and the
binding rules in agent-rules/events.md. Read both before starting.

## Implement (in `src/bus/`)

- Event envelope: `{seq, timestamp, event, payload, module}` — timestamp from
  the `Clock` port, `seq` monotonically increasing.
- Typed event map: one interface mapping event name → payload type, seeded
  with the catalog in docs/EVENTS.md (payloads may be refined by later stages,
  additively). `emit` and `subscribe` are typed against it.
- `subscribe(event, handler)` / `subscribeAll(handler)` returning an
  unsubscribe function.
- Handler isolation: a throwing handler is caught, logged, and skipped; the
  emitter never sees the error; remaining handlers still run.
- Ring buffer: fixed capacity (config later; constructor arg now, default
  1000), `replay({sinceSeq?, sinceTs?})` for `pitlane events`.

## Tests first

- Emit delivers to all subscribers of that event and to subscribeAll.
- A throwing handler doesn't prevent later handlers or the emitter.
- Unsubscribe works; unsubscribe during dispatch doesn't corrupt iteration.
- Ring buffer: wraps at capacity, replay(sinceSeq) returns the right slice,
  replay after wrap only returns retained events.
- Envelope fields populated (timestamp from FakeClock, seq increments).

## Watch out

- Dispatch synchronously in emit order — simple and deterministic. Do NOT
  make handlers async-awaited by the emitter (agent-rules/events.md rule 4);
  an async subscriber schedules its own work.
- No wildcard/namespace matching, no once(), no priorities — YAGNI.
- The bus does not enforce "post-commit" (that's a caller discipline rule),
  but the typed event map is the enforcement point for naming: adding an
  event here requires updating docs/EVENTS.md in the same commit.

## Acceptance criteria

- [ ] Typed bus + ring buffer in `src/bus/`, using the Clock port.
- [ ] All tests above pass; handler isolation verified.
- [ ] Event names in the type map match docs/EVENTS.md exactly.
- [ ] `pnpm check` green.
