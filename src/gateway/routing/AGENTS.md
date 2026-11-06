# Gateway routing

Does: picks the worker for one fleet request, or says it cannot be served. Pure, over views.
Flows: [device selection](../../../docs/internal/flows/device-selection.md), [gateway](../AGENTS.md).

## Rules

Stages:

- Stages read the view and the request only. No clock, no I/O, no state.
- A filter returns its own reason and a rank its own zero reason. The pipeline and the policy
  name no stage and compare no stage name.
- `gateway.routing` names a whole list; stage order is code, never config.
- `memory-pressure` reads only the step a worker reports (`new-devices-paused` scores 0, `warming-paused` ranks as calm); the gateway applies no threshold.
- A rank abstains when its best score is 0 or less, and a settling rank ends the walk. A worker
  is picked only if some rank decided: filters alone pick no one.
- Workers are walked in id order, and the pick is the first one left.
- A physical request skips every stage with `appliesToPhysical: false`. That leaves it one rank,
  `warm-hit`: with no pickable device nothing is picked, and the request waits.
- `explain` decides nothing: it gives, per view, the reason `select` would pass it over.

Serviceability (`assess`):

- The first check that applies wins, so the order of the checks is the answer a caller gets.
- A request naming a baseline is checked first; the rest of the table then runs over the
  fitting, fresh holders only, with the request narrowed by `withBaseline`.
- A known worker is one that is not `incompatible`. What no known worker could serve is rejected
  with its own code; what a known worker could serve but none taking requests can is `NO_CAPACITY`.
  An updating worker counts as taking requests here, so a request only it can serve waits.
- `can-serve` and `assess` ask the same helpers in the same order, so the reason
  `can-serve` gives is the code the table would reject with. `has-baseline` and `assess` share
  `baselineEntry` and `withBaseline`; no field of a baseline is compared in the gateway.
- A request with `except` (ADR 0066 §5) is checked after the model and runtime rows and before the capacity row.
- Downloads never make a worker able to serve: only installed runtimes count.
- `matchRequest` gives the model name the gateway forwards, so the worker resolves what routing matched.
