# Seed settle

Does: settles quick seeds in the background, one at a time, when the worker is quiet (ADR 0090). The drivers' `settleSeed` and `ensureSeed` do the work; this decides when.
Flows: [startup](../../../docs/internal/flows/startup.md). Parent: [core](../AGENTS.md).

## Rules

- `nextSettle` (`policy.ts`) is pure and the only place the quiet rules live. `settler.ts` is the mechanism: timers, claims, the driver call.
- A settle holds a creation reservation (`tryReserveProvisioning`) and a `provision` component claim, both taken in `decisions.run`. The driver call runs outside it.
- Gates, in order: memory pressure not `none`, free disk under `diskPressure.freeBytesThreshold`, a settle running, an operator waiting (skips the next two), a boot or creation under way, a release in the last 5 minutes. Then the quick seed with most leases; a failed one waits 1 hour.
- An abort gives no warning and no failure delay: `memory-pressure` (at `new-devices-paused`), `daemon-stopping`, `nuke`.
- Nuke runs inside `holdWhile`: it aborts a settle, waits for it, and the settler starts nothing until the work is done.
- `beginStop` at stop start rejects queued operator settles and aborts the running one; `stop` waits for it. Both come before the drivers are disposed.
- Events are emitted only when the driver's `settleSeed` is called: nothing for an operator call on a seed that is already settled.
- The first check runs 5 minutes after `start()`, not at it.
