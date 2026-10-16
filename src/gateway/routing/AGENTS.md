# Gateway routing

Does: picks the worker for one fleet request, or says it cannot be served. Pure, over views.
Entry: `index.ts`; composed in `../routing.ts` → `createRoutingPolicy(gateway.routing)` →
`{ assess, select }`. Only policy: `warm-then-free`.
Uses: contract, core (catalog match only). Called by: `../fleet-coordinator.ts`.
Flows: [device selection](../../../docs/internal/flows/device-selection.md), [gateway](../AGENTS.md).

## Files

| File                | Role                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `serviceability.ts` | `assess`: the fast-fail table, over every view                     |
| `pipeline.ts`       | `runStages`; `FilterStage`, `RankStage`                            |
| `request-match.ts`  | `matchRequest`, `deviceFit`, `physicalMatch` over a view's catalog |
| `view-state.ts`     | `viewLoadKey`: the view fields a refusal is remembered against     |
| `stages/`           | One file per stage                                                 |

## How it works

1. **Assess** (`assess`), first that applies wins: no worker passes `takes-requests` →
   `NO_CAPACITY` (`no-worker`); no known worker has the platform → `NO_DRIVER`; none lists the
   model or class → `UNKNOWN_MODEL`; none pairs it with a fitting runtime → `RUNTIME_MISSING`
   (`downloadable: false`); a known worker could, but none taking requests can → `NO_CAPACITY`;
   `requires` met by none that could → `CAPABILITY_MISSING`. Else route or wait.
   Physical: no known worker enrols a fitting device → `UNKNOWN_MODEL`. Known = not `incompatible`.
2. **Select** (`runStages`): workers sorted by id. A filter drops; a rank keeps its best scorers,
   abstains when the best is 0 or less, and a settling rank ends the walk. Pick the first left,
   only if some rank decided. A physical request skips stages with `appliesToPhysical: false`.
3. The reported stage is the last rank that removed a worker, else the last that decided.
   `reason` is `warm-hit` when that stage is `warm-hit`, else `free-capacity`.

| Stage              | Kind          | Keeps or prefers                                                                                      | Physical |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| `takes-requests`   | filter        | connected, not drained, capacity and catalog read this session (`starting`: a catalog held)           | yes      |
| `has-capabilities` | filter        | every `requires` entry `available`                                                                    | yes      |
| `can-serve`        | filter        | catalog serves model or class with an installed fitting runtime; physical: an enrolled fitting device | yes      |
| `healthy`          | filter        | health `running`                                                                                      | yes      |
| `idle-queue`       | filter        | the worker's own `queueDepth` is 0                                                                    | no       |
| `warm-hit`         | rank, settles | a `ready` fitting device of the asked mode (`servesDefaultMode` if none); physical: a pickable one    | yes      |
| `free-slot`        | filter        | a free or evictable (warm) running slot, platform and global                                          | no       |
| `ram-budget`       | rank          | `atRamBudget` not true                                                                                | no       |
| `free-capacity`    | rank          | most `maxRunning - running - reserved`                                                                | no       |

A physical request has one rank, `warm-hit`: with no pickable device nothing is picked, and it waits.

## Rules

- Stages read the view and the request only. No clock, no I/O, no state.
- `gateway.routing` names a whole list; stage order is code, never config.
- Downloads never make a worker able to serve: only installed runtimes count.
- `matchRequest` gives the model name the gateway forwards, so the worker resolves what routing matched.
