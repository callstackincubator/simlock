# Capacity

Does: how many virtual devices may exist and run at once — limits, RAM budget, reservations, figures.

## Rules

- A strategy is pure; only `CapacityCoordinator` holds state, and its reservations live in memory only.
- Capacity knows nothing of queues, the registry or drivers. The caller holds the lock, passes a fresh snapshot for every decision, and keeps its reservation until its operation ends.
- Status and the planner ask the same questions (`canProvision`, `runningCapacity`), so they cannot disagree. `atRamBudget` asks the same `canProvision` the planner uses.
- `devices.ts` is the one place a record or a spec becomes a capacity device: a device `provisioning` or about to be created counts `full`, any other by its record's `mode`.
- Until its reservation is released, a device being booted counts `full` and no longer `shutdown`, so it holds RAM in every decision.
- `ramBudget` reads devices only; reservations are left out.
- Running slots ignore mode; RAM does not. A `quarantined` device holds a running slot. Physical devices are never read.
- A boot refused for RAM evicts nothing; the request waits.
- Over the RAM limit (sizes raised by a restart), every create and every boot that adds RAM is refused. Nothing is stopped or reclaimed for it.
- Release is idempotent. Every take and release calls the observer.
- `CapacityObserver.changed()` runs after every registry commit and reservation change, and emits `capacity.changed` only when the payload differs from the last one. It is silent until `start()` in `core.converge`, which emits once.
- Top-level `limits` and `ramBudget` are folded into `capacity.config` under `resource`, and ignored with a warning under `fixed` (`core/config.ts`).
- Adding a strategy is a directory under `strategies/` and one line in its `index.ts`.

## Known gaps

- **A recovery reboot is not checked.** `recoverLeased` boots a slim device full, outside any
  reservation; the record keeps counting it slim until it is next prepared.
