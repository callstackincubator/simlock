# Capacity

Does: how many virtual devices may exist and run at once — limits, RAM budget, reservations, figures.
Entry: `index.ts` → `CapacityCoordinator` over `createCapacityStrategy(config.capacity, systemStats)`,
built by `createCore` as `core.capacity`; read side `core.capacityReader`.
Uses: ports (`SystemStats`), bus, `core/validation.ts`. Knows nothing of queues, the registry or drivers.
Callers: leasing's `AcquisitionPlanner`, the warm pool, `status.get`. Parent: [core](../AGENTS.md).

## Files

| File             | Role                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `strategy.ts`    | `CapacityStrategy` interface, `defineCapacityStrategy`, refusal reasons             |
| `strategies/`    | `index.ts`: the strategy map; `strategies/resource/`, `strategies/fixed/`           |
| `limits.ts`      | Running states, `runningCapacity`, `canReserveRunning`, `withinDeviceLimit`         |
| `coordinator.ts` | `CapacityCoordinator`: reservations around the pure strategy                        |
| `devices.ts`     | `capacityDevice`, `plannedCapacityDevice`: the one record → capacity device mapping |
| `figures.ts`     | `buildCapacityFigures`: what `status.get` reports                                   |
| `observer.ts`    | `CapacityObserver`: emits `capacity.changed`                                        |
| `testing.ts`     | Test-only: `resourceStrategy`                                                       |

## How it works

1. **Strategy** — `capacity.strategy` picks one from `capacityStrategies`; `capacity.config` is its
   own options block, validated by the strategy. A strategy is pure.
2. **Running** — a virtual device in `ready`, `leased`, `reclaiming` or `quarantined` holds a running
   slot. Physical devices are never read. Global and platform limits are checked together;
   refusals `global-running-limit`, `platform-running-limit`.
3. **Device limit** — every virtual device not `deleted` counts against its platform's `maxDevices`;
   refusal `device-limit`.
4. **Mode** — `devices.ts`: a device `provisioning` or about to be created counts `full`; any
   other by its record's `mode`.
5. **Reserve** (caller holds the lock, passes a fresh snapshot):
   - `tryReserveProvisioning(planned, devices)` — `canProvision`, then a running slot. Counts as a
     device and a running slot until released.
   - `tryReserveBoot(device, devices)` — `canBoot` (RAM first), then a running slot. The device
     counts `full` in every decision until released.
   - Release is idempotent. Every take and release calls the observer.
6. **Read** — `runningCapacity` (running, reserved, max, `overLimit` per platform and global),
   `deviceLimit`, `ramBudget` (devices only, reservations left out), `atRamBudget(platform)`: would
   one more `full` device be refused for RAM, by the same `canProvision` the planner uses.
7. **Figures** — `buildCapacityFigures`: per platform the running entry plus `limit`, `used`
   (not `deleted`), `warm` (`ready`), `atRamBudget`; global with `warm`; `ramBudget` when kept.
8. **Event** — `CapacityObserver.changed()` after every registry commit and reservation change;
   emits `capacity.changed` only when the payload differs from the last one. Silent until
   `start()` in `core.converge`, which emits once.

## Strategies

**`resource`** (default). Limits from the machine, plus a RAM budget.

- Limit = `totalRamBytes` − 4 GiB. Used = sum over every device not `deleted` (shut down
  included), each by platform and mode; a slim size left unset is the full size.
- `canProvision`: device limit, then used + new device's size > limit → `ram-budget`.
- `canBoot`: extra = full size − own size; refused `ram-budget` when used + extra > limit.
- Over the limit (sizes raised by a restart): every create and every boot that adds RAM is
  refused. Nothing is stopped or reclaimed for it.

**`fixed`**. A pinned number, no machine read, no RAM budget, mode ignored, `canBoot` always ok.
A platform's `maxRunning` defaults to the global one, its `maxDevices` to its `maxRunning`.

## State and timers

| What                          | Default                               | Key                                             |
| ----------------------------- | ------------------------------------- | ----------------------------------------------- |
| Strategy                      | `resource`                            | `capacity.strategy`                             |
| Global running (`resource`)   | iOS + Android `maxDevices`            | `capacity.config.limits.maxRunning`             |
| iOS devices and running       | max(1, ⌊cpu / 2⌋)                     | `capacity.config.limits.ios.*`                  |
| Android devices and running   | max(1, min(⌊cpu / 4⌋, ⌊RAM GiB / 8⌋)) | `capacity.config.limits.android.*`              |
| RAM per device, iOS / Android | 1.5 GiB / 4 GiB                       | `capacity.config.ramBudget.*BytesPerDevice`     |
| Slim RAM per device           | the full size                         | `capacity.config.ramBudget.*SlimBytesPerDevice` |
| Global running (`fixed`)      | 2                                     | `capacity.config.maxRunning`                    |

Top-level `limits` and `ramBudget` are folded into `capacity.config` under `resource`, and
ignored with a warning under `fixed` (`core/config.ts`). Reservations live in memory only.

## Rules

- A strategy is pure; only `CapacityCoordinator` holds state.
- Adding a strategy is a directory under `strategies/` and one line in its `index.ts`.
- Status and the planner ask the same questions (`canProvision`, `runningCapacity`), so they
  cannot disagree.
- A boot refused for RAM evicts nothing; the request waits.
- Running slots ignore mode; RAM does not.

## Known gaps

- **A recovery reboot is not checked.** `recoverLeased` boots a slim device full, outside any
  reservation; the record keeps counting it slim until it is next prepared.
