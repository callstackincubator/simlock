# 0007. A lease request chooses the device mode

- **Status:** Proposed
- **Date:** 2026-10-01
- **Issue:** [#172](https://github.com/callstackincubator/simlock/issues/172)
- **Supersedes:** nothing. Narrows [ADR
  0002](0002-opt-in-slim-ios-simulators.md) §1, §3, §4, §6 and §8: slim is no
  longer a switch on the worker, `full` is no longer the only per-lease
  control, and `featureProfile` and `reducesFeatures` are gone. ADR 0002 §2,
  §5, §7, §9 and §10 stand. Narrows [ADR
  0004](0004-ttl-first-leases-on-every-transport.md): the `mode` key it
  removed from the lease request returns with a new meaning (§9). The
  Android slim record on branch
  `claude/inspiring-volta-g3soer` was written against ADR 0002 and is
  rewritten against this one before it lands, under a new number.

## Context

ADR 0002 made slim a setting of the worker. `ios.slim.enabled` turns it on,
and from then on every device is slim unless the request says `full`. The
core knows two facts: whether a driver may reduce a device
(`reducesFeatures`, true only while the switch is on) and whether it did
(`featureProfile`).

That shape has three faults.

- A request can opt out of slim and cannot opt in. On a worker with the
  switch off nobody gets a slim device.
- In a gateway fleet the same request gets a different kind of device
  depending on the worker it lands on, and the requester cannot say which
  kind it wants.
- The switch reads as an ability: "this worker is slim". It is a default.
  A slim worker already makes full devices on request.

Android slim (#159) is about to copy the same shape.

## Decision

### 1. The mode is a choice of the request

A lease request carries an optional `mode`: `slim` or `full`. It replaces
`full: true`. A request that names no mode gets the worker's default for the
platform, set by `ios.defaultMode` (and `android.defaultMode` when Android
slim lands). The default is `full`.

`ios.slim.enabled` is removed. The other `ios.slim.*` keys stay and describe
how a slim device is made, whatever the default is.

### 2. The default is resolved once, in the core

The composition root builds a map from platform to default mode out of the
config. `LeaseAcquisitionCoordinator` reads it where it resolves a request
into a spec, and nowhere else does a missing mode get a value. Transports
pass the request's mode through untouched, so `lease.requested` shows what
was asked, not what it resolved to.

A driver never holds a default. A gateway has none either: it forwards the
mode as it arrived, and a request with no mode reaches the worker with no
mode.

### 3. Every worker honours both modes

`Driver.reducesFeatures` is deleted and nothing replaces it. A driver that
can slim does so for any slim spec, whatever the worker's default.

### 4. Slim is best effort, decided by the driver when it resolves the spec

`resolveSpec` receives the resolved mode. The driver returns a slim spec only
when it will slim that device: on iOS, when the runtime is 18.5 or newer. For
any other runtime, and from any driver that does not slim at all, a slim
request resolves to a full spec.

The decision is made before planning, so such a request pools with full
devices and is counted as one. It is never an error.

### 5. Full is a guarantee, enforced in the core

The coordinator accepts a slim spec from a driver only when the resolved mode
is slim. A `full` request can therefore never be planned onto a slim device,
even against a driver that returns the wrong thing.

### 6. Pool identity is the spec's mode

`DeviceSpec` carries `mode: "slim"` for a slim device and no mode for a full
one. `full?: true` is removed. `sameSpec` compares the mode, so slim and full
devices of one model and runtime never share a pool. A device's spec mode
does not change for as long as the device exists.

### 7. The registry is the only record of a device's planned mode

The core hands the spec's mode to the driver on every `makeReady`. The driver
keeps no copy: the iOS driver stops stamping `full` into its driver data. A
recovery boot applies no slim pass, as today.

### 8. The reported mode is what the device actually has

`DriverDevice` reports `mode` after each `makeReady`, and the record stores it
on every readiness transition, as `featureProfile` was. It can differ from
the spec's mode: a slim device whose pass did not run reports `full`, stays
in the slim pool, and is slimmed on its next prepare boot. ADR 0002 §10
stands: a partial or uncertain pass reports `slim`.

A slim request may be granted `mode: "full"`. A full request is never granted
`mode: "slim"`.

### 9. One word on every surface

The lease, the device in status, and the device in a list all report `mode`
with the values `slim` and `full`. `featureProfile` and the HTTP `slim` flag
are removed. No response carries the spec's mode, so a response never shows
two modes for one device. The lease record carries none. The one place the
spec's mode is visible is the `device.provisioned` event (§13), which reports
what was planned before the device ever booted.

`mode` was a lease request field until ADR 0004 retired it. It is reused on
purpose. A client that still sends the retired value gets `BAD_REQUEST`,
because that value is neither `slim` nor `full`. `status` also reports the
daemon's own `mode` (`worker` or `gateway`); the docs say "device mode" where
the two could be confused.

### 10. Unknown fields fail on every transport

A request carrying `full` is `BAD_REQUEST` on the socket, MCP, and HTTP. The
HTTP lease request body becomes strict to make that true; today it drops
unknown keys silently.

### 11. No migration, no alias

`full`, `--full`, `ios.slim.enabled`, `featureProfile`, and the HTTP `slim`
flag are removed in one step. The old config key gets the generic
unknown-key warning.

A device record written before this change has no mode and loads as full. A
worker that ran with slim on therefore has slimmed devices that load as full,
and it would grant them to `full` requests. The operator empties such a
worker with `simlock nuke --delete-devices` before upgrading. The upgrade
notes and the known-pitfalls list say so. This is the one case where the
guarantee in §5 does not hold: it covers devices made after this change. The
maintainer chose this over deriving the mode from the old record.

### 12. The wire changes without a shim

Each PR that changes a response or request shape raises the protocol version
by one. The range does not widen. A worker on the older protocol shows as
`incompatible` on its gateway and is sent nothing.

### 13. Events change by one key

No event is added. `lease.requested` and `lease.rejected` carry the request,
and `device.provisioned` carries the spec, so `full` leaves those payloads
and `mode` enters. That is a removal, against events rule 6. This record
takes that exception once, while the package is 0.x, as ADR 0004 did, and the
note at the top of `EVENTS.md` records it. `device.slimmed` is unchanged.

### 14. The slim advisory follows the default

`simlock doctor` reports runtimes that cannot be slimmed only on a worker
whose default mode is `slim`. The composition root passes the driver a
boolean saying so. The driver is not given the default itself.

## Consequences

- An agent can ask for the mode its test needs on any worker, and a mixed
  fleet answers the same request the same way.
- A worker holds slim and full devices side by side. The RAM budget still
  counts one size per device, so a budget sized for slim overcommits when
  full devices are leased. #174 fixes that; until then it is a known pitfall.
- A gateway does not look at the mode when it picks a worker. A slim warm
  device still counts as a warm hit for a `full` request, as today. #173
  fixes that.
- A worker upgraded without being emptied can hand out a slimmed device as
  full (§11).
- Two protocol bumps if the work lands as two PRs.
- #159, #163 and #164 build on this record: `android.defaultMode`, slim specs
  from the Android `resolveSpec`, the mode from the `makeReady` option.
- The docs change with the implementation. Each PR updates the docs it makes
  true.

## Alternatives considered

- **Keep the worker switch and add `slim: true` beside `full: true`.**
  Nothing breaks. Rejected: two booleans do the job of one field and can
  contradict each other, and the switch keeps reading as an ability.
- **Strict slim: fail when the device cannot be slimmed.** Rejected. Slim
  saves host memory; no test needs it. Failing would force a gateway to know
  which runtimes each worker can slim, which puts the mode back into what a
  worker advertises.
- **A default mode on the gateway.** One answer per fleet for a request with
  no mode. Rejected for now: it needs a mode on the gateway-to-worker hop
  that only the gateway may set, and nobody asked for it.
- **Resolve the default in each driver.** Rejected. The rule would exist
  twice once Android slim lands, and the fake drivers used by the fast test
  lane get no config, so the default could not be tested there.
- **A `canSlim(spec)` driver capability, with the core stamping the mode.**
  A smaller diff. Rejected: the iOS driver would need a second, synchronous
  look-up of the runtime behind a spec, which its own comments warn against.
- **Derive the mode of old records at load.** Safe and cheap. Not chosen:
  the maintainer prefers no migration code and a documented upgrade step.
