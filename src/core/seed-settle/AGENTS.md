# Seed settle

Does: settles quick seeds in the background, one at a time, when the worker is quiet (ADR 0090). The drivers' `settleSeed` and `ensureSeed` do the work; this decides when.
Flows: [startup](../../../docs/internal/flows/startup.md). Parent: [core](../AGENTS.md).

## Rules

- A settle holds a creation reservation (`tryReserveProvisioning`) and a `provision` component claim, both taken in `decisions.run`. The driver call runs outside it.
- An abort gives no warning and no failure delay: `memory-pressure` (at `new-devices-paused`), `daemon-stopping`, `nuke`.
- Nuke runs inside `holdWhile`: it aborts a settle, waits for it, and the settler starts nothing until the work is done.
- `beginStop` at stop start only makes the settler start nothing and refuse new operator calls; `stop` rejects the queued ones, aborts the running settle and waits for it. Both come before the drivers are disposed.
- Events are emitted only when the driver's `settleSeed` is called: nothing for an operator call on a seed that is already settled.
- An operator call waits 60 minutes from its arrival, then fails `timed-out`; a settle it started goes on.
