# Stage 05 — Config & capacity

Goal: effective configuration (defaults derived from the machine, overridden
by file) and the capacity accounting the lease engine will consult.

## Implement (in `src/core/`)

- **Config schema + loading**: defaults → `~/.pitlane/config.json` → explicit
  overrides (for tests/flags). Unknown keys warn, don't fail. Keys:
  - `limits.ios.maxDevices` — default `max(1, floor(cpuCount / 2))`
  - `limits.android.maxDevices` — default
    `max(1, min(floor(cpuCount / 4), floor(totalRamGb / 8)))`
    (RAM is the binding constraint for emulators)
  - `ramBudget.iosBytesPerDevice` default 1.5 GiB;
    `ramBudget.androidBytesPerDevice` default 4 GiB
  - `idle.shutdownAfterMs` (T1) default 10 min;
    `idle.deleteAfterMs` (T2) default 60 min
  - `lease.heldTtlBackstopMs` default 60 min;
    `lease.detachedTtlMs` default 15 min
  - `diskPressure.freeBytesThreshold` default 10 GiB
  - `warmPool` — reserved key, default `{}` (policy is post-v1; the reaper
    invariant reads it, so it must exist)
  - `eventBuffer.capacity` default 1000
- **Capacity module**: given registry counts (devices not in `deleted`,
  per platform) + config + SystemStats: `canProvision(platform)` →
  `{ok: true} | {ok: false, reason: 'device-limit' | 'ram-budget'}`.
  RAM check: (existing devices × budget) + budget ≤ totalRam − reserve
  (reserve: 4 GiB for the OS).

## Tests first

- Derived defaults with FakeSystemStats (e.g. 8 cores / 32 GB → ios 4,
  android 2 by the formulas above — assert the formulas, not magic numbers).
- File overrides beat defaults; explicit overrides beat file; partial config
  files merge deep.
- Malformed config file → clear error naming the offending key.
- Capacity: at limit → device-limit refusal; under count limit but over RAM
  budget → ram-budget refusal; `deleted` devices don't count.

## Watch out

- Config values are all injected — no `SystemStats` reads outside the
  defaults computation, no re-reading the file after startup (config is
  immutable per daemon run; `pitlane config set` writes the file, takes
  effect on restart — document that in the CLI stage).
- Durations in ms everywhere internally; parse human forms ("10m") only at
  the CLI boundary, not here.

## Acceptance criteria

- [ ] Effective-config precedence (defaults < file < overrides) tested.
- [ ] Default formulas implemented exactly as specified above.
- [ ] Capacity refusals distinguish device-limit vs ram-budget.
- [ ] `pnpm check` green.
