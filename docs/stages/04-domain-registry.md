# Stage 04 — Domain model, state machine & registry

Goal: the shared device lifecycle and the persistent managed-device registry
— the single source of truth (agent-rules/architecture.md rule 6).

## Implement (in `src/core/`)

- **Domain types**: `Platform` ('ios' | 'android'), `DeviceSpec`
  {platform, model, osVersion}, `DeviceRecord` {id, spec, state,
  driverData (opaque per-driver blob), createdAt, lastLeaseEndedAt?, ...},
  `LeaseRecord` {id, deviceId, requesterId, mode: 'held' | 'detached',
  grantedAt, ttlDeadline}.
- **State machine**: states `provisioning | ready | leased | reclaiming |
warm | shutdown | deleted` with an explicit legal-transitions table and a
  single `transition(record, to)` function that throws `IllegalTransition`
  otherwise. Legal edges:
  provisioning→ready|deleted (provision failed → cleanup),
  ready→leased|shutdown, leased→reclaiming, reclaiming→ready|warm|shutdown,
  warm→ready|shutdown, shutdown→ready(reboot)|deleted.
- **Registry**: holds DeviceRecords + LeaseRecords in memory; persists to
  `~/.pitlane/state.json` via `Filesystem.writeFileAtomic` after every
  mutation; `load()` tolerates unknown fields and missing file (fresh start).
  All state changes go through registry methods that use `transition()` —
  no direct mutation from outside. After a successful commit the registry
  emits the corresponding `device.*` event on the bus (post-commit rule).
- ID generation: `dev_`/`lse_` prefixed, crypto-random suffix (via a small
  injectable IdGenerator or the Clock/seed — keep deterministic in tests).

## Tests first

- Every legal transition succeeds; a representative set of illegal ones
  (ready→deleted, leased→shutdown, deleted→anything) throws.
- Persistence round-trip: mutate, reload from MemoryFilesystem, state equal.
- Load with missing file → empty registry; load with extra unknown JSON
  fields → preserved on next save (forward compatibility).
- Events: mutation emits the right `device.*` event AFTER the save (order
  assertable with a spy filesystem + subscriber).
- Registry rejects deleting/mutating a device id it doesn't know.

## Watch out

- `driverData` is opaque to the core — no ios/android fields in core types
  (architecture rule 1/2). UDIDs and AVD names live inside driverData.
- Leases reference devices by id; registry must refuse to delete a device
  with an active lease (safety rule 2 enforced at the data layer too).
- Don't add query helpers speculatively; stage 07 will add what it needs.

## Acceptance criteria

- [ ] State machine table matches ARCHITECTURE.md; illegal transitions throw.
- [ ] Registry persists atomically via the Filesystem port; survives reload.
- [ ] `device.*` events emitted post-commit.
- [ ] No platform-specific fields in core types.
- [ ] `pnpm check` green.
