# Stage 02 — Global and platform `maxRunning`

Goal: add a hard admission limit for devices that are running or being
started, independent of the existing managed-device provisioning limits.

## Current state

`maxRunning` does not exist. The current configuration only has:

```json
{
  "limits": {
    "ios": {"maxDevices": 4},
    "android": {"maxDevices": 2}
  }
}
```

`maxDevices` counts registry devices not in `deleted` state and only prevents
additional provisioning. It does not limit booting existing devices.

## Configuration

Extend the schema:

```json
{
  "limits": {
    "maxRunning": 3,
    "ios": {
      "maxDevices": 4,
      "maxRunning": 2
    },
    "android": {
      "maxDevices": 2,
      "maxRunning": 2
    }
  }
}
```

All three `maxRunning` values are positive integers:

- `limits.maxRunning`: global limit across every registered driver/platform.
- `limits.ios.maxRunning`: iOS-only running limit.
- `limits.android.maxRunning`: Android-only running limit.

An operation that would start a device is allowed only when both the global
and relevant platform limit have a free slot.

Defaults must preserve today's effective behavior:

- each platform's `maxRunning` defaults to its derived `maxDevices`;
- global `maxRunning` defaults to the sum of the platform defaults.

No relation such as `maxRunning <= maxDevices` needs separate validation:
`maxDevices` already caps managed devices, while independently configured
running limits may be higher without making the system unsafe.

## Running-device accounting

Count a registry device as running while its state is:

- `ready`
- `leased`
- `reclaiming`
- `warm`

Starting a `shutdown` device and provisioning a device both require a running
reservation before the driver operation begins. Reservations count toward the
global and platform limits until the operation commits as ready/leased or
fails and releases the reservation.

Treat reservations as the concurrency lock for accounting. A booting shutdown
device still appears as `shutdown` in the registry until readiness succeeds,
so registry state alone is insufficient.

Conservative rule: an uncertain/in-flight device consumes a running slot until
the core has committed that it is shutdown or deleted.

## Admission behavior

- Granting an already `ready` matching device is allowed at the limit because
  it does not increase the number of running devices.
- Reusing a `warm` device does not consume a new slot because warm already
  counts as running.
- Booting a `shutdown` device requires both a global and platform slot.
- Provisioning requires the existing `maxDevices`/RAM checks plus both
  running-limit checks.
- At either running limit:
  - normal requests enter the existing FIFO queue;
  - `--no-wait` returns the existing capacity exit code `11`;
  - no driver `provision` or `makeReady` call begins.
- A transition to `shutdown` or `deleted` releases capacity and wakes the queue.
- Queue ordering remains FIFO; this stage does not introduce per-platform
  queues or bypass the head waiter.

## Existing excess on startup or after lowering limits

Configuration takes effect on daemon restart. On startup:

1. Reconcile registry state with driver reality before enforcing counts.
2. Never stop or reclaim a leased device, even if leased devices alone exceed
   a limit.
3. Deterministically shut down excess unleased `ready`/`warm` devices through
   the normal lease-engine/driver transition path until both limits are met.
4. If leased devices keep the daemon over a limit, report the over-limit state,
   admit no operation that increases running count, and converge naturally as
   leases release.

This is the only safety exception to the hard limit: safety rule 2 takes
precedence over immediately enforcing a newly lowered limit.

## Status and observability

Extend `status --json` additively so operators can distinguish managed capacity
from running capacity:

```json
{
  "capacity": {
    "global": {
      "running": 2,
      "maxRunning": 3,
      "reserved": 0,
      "overLimit": false
    },
    "ios": {
      "used": 3,
      "limit": 4,
      "running": 1,
      "maxRunning": 2,
      "reserved": 0,
      "overLimit": false
    }
  }
}
```

Keep existing `used`/`limit` platform fields for compatibility. Update the
human status table and configuration documentation.

No new event is required solely for a refused admission; existing
`lease.queued`/`lease.rejected` facts remain authoritative.

## Tests first

- Config defaults, file overrides, explicit overrides, deep merge, and
  validation for all three `maxRunning` keys.
- Global limit: one iOS device is running; an Android boot/provision request
  queues even though Android's platform limit has room.
- Platform limit: iOS is full; another iOS start queues while Android can
  start when it is the queue head.
- **Load-bearing reservation race:** global and iOS `maxRunning` are one; two
  simultaneous requests with no devices cause exactly one `provision` and one
  `makeReady`; the second remains queued until the first device becomes
  shutdown.
- Two existing shutdown devices, limit one: concurrent lease requests start
  exactly one driver `makeReady`.
- A ready unleased device can be granted while running counts are exactly at
  the limit.
- A no-wait request rejected by global or platform running capacity makes no
  driver calls and maps to exit code 11.
- Reclaim returning `shutdown`, cleanup shutdown, boot failure, provision
  failure, and destroy each release any applicable reservation and wake the
  queue without leaking capacity.
- Reclaim returning `ready` retains its existing running slot.
- Startup over-limit convergence shuts down only unleased registry devices,
  is deterministic and idempotent, and never touches a leased or unregistered
  device.
- Startup with leased devices above the limit reports `overLimit: true` and
  starts nothing new.
- Status JSON and human rendering distinguish managed, running, and reserved
  counts globally and per platform.
- Mixed iOS/Android contention verifies both limits together.

## Implement

1. Extend config types, defaults, validation, CLI config output, and docs.
2. Add a platform-agnostic running-capacity calculation in `src/core/`.
   Keep it separate from driver implementations.
3. Centralize running reservations in the lease engine's serialized decision
   path. Driver operations remain outside the lock.
4. Check running admission before selecting provision or boot-shutdown
   actions. Existing provisioning/RAM capacity remains a separate check.
5. Release reservations on every success, rejection, timeout, connection
   close, driver failure, cleanup, and nuke path.
6. Wake the FIFO queue after committed transitions that may free a running
   slot.
7. Add startup over-limit convergence through existing driver verbs and
   registry transitions; do not create a separate destruction/shutdown path.
8. Extend daemon status and CLI rendering additively.
9. Update `docs/ARCHITECTURE.md`, `docs/CLI.md`, and the root README config
   example.

## Watch out

- The global and platform checks must be atomic within the same decision
  section; checking them separately around an await recreates the race this
  stage exists to prevent.
- Do not infer running state from driver-specific data, PIDs, UDIDs, AVD
  ports, or platform branches in core.
- Registry state alone cannot represent a boot in progress; reservations are
  mandatory.
- Never hold the decision lock across a driver call.
- Never enforce over-limit convergence by touching leased or non-registry
  devices.
- Lowering limits may leave the daemon temporarily over limit when active
  leases consume all slots. This must be visible, not silently ignored.
- Preserve the existing `maxDevices` semantics and status fields.

## Acceptance criteria

- [ ] Global and per-platform `maxRunning` configuration is loaded, validated,
      documented, and exposed by `pitlane config`.
- [ ] No action can increase running devices unless both applicable limits
      have a reserved slot.
- [ ] Concurrent requests cannot oversubscribe global or platform limits.
- [ ] Existing ready devices remain leasable at the limit without consuming a
      second slot.
- [ ] Shutdown/failure paths release reservations and wake queued work.
- [ ] Startup converges excess unleased devices safely and reports unavoidable
      leased overage.
- [ ] Status reports managed, running, reserved, and over-limit values.
- [ ] Capacity-one CLI contention is covered end to end with truthful progress
      from the existing lease-progress implementation.
- [ ] No platform-specific logic leaks into core.
- [ ] `pnpm check` is green.
