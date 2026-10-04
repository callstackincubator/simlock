# 0015. A lease request is a set of constraints, and the catalog says which class each model is

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-04
- **Issue:** [#326](https://github.com/callstackincubator/simlock/issues/326)
- **Supersedes:** nothing. Narrows [ADR
  0003](0003-one-typed-daemon-contract-behind-every-frontend.md) §1 by one
  module: the OS-range grammar lives in the contract, which the core and the
  gateway import, so the contract still imports nothing from the core.
  Narrows [ADR
  0008](0008-the-catalog-pairs-models-with-runtimes-and-status-carries-host-facts.md)
  §1 and §9: the catalog gains two fields, and one of them (`classDefaults`)
  is shaped by config. Narrows [ADR
  0009](0009-gateway-routing-is-a-list-of-stages.md) §3 (the gateway forwards
  a class as it arrived, since there is no worker name for a class), §4 (the
  table reads classes and ranges) and §6 (the gateway compares versions, for
  a range only). Builds on [ADR
  0007](0007-a-lease-request-chooses-the-device-mode.md): the mode of a fit
  is the one §4 and §5 decided for the request.
- **Depends on:** ADR 0008 (#171, closed) and ADR 0009 (#173, open).

## Context

A lease request names one model and, optionally, one exact OS version. The
core turns it into one `DeviceSpec` and the planner grants a device only when
`sameSpec` holds. An agent that wants "an iPhone on iOS 18 or newer" must
pick a model and a version itself, and a warm iPhone 15 on 18.4 is useless to
a request that guessed iPhone 16.

#326 lets a request name a class (`phone`, `tablet`, `watch`, `tv`, `vision`,
`auto`, `desktop`) or nothing, and an OS range. Four things have to be
decided once, because five tasks and both gateway and worker read them: what
the request looks like on the wire, where a model's class comes from, where
a request is turned into something a device can fit, and how a gateway
routes a request that names no model.

## Decision

### 1. The request names a model, a class, or nothing

`lease.request` makes `model` optional and adds `class`, an enum of the seven
class names. A request with both is `BAD_REQUEST`, decided by the contract
schema so every transport answers alike. A request with neither means
`class: "phone"`. That is a constant of the contract, not a worker setting:
one function beside the schema answers which class a request means, the
worker's coordinator reads it where it resolves a request, and the gateway
reads it where it matches one. No transport fills it in, so
`lease.requested` shows what was asked. The HTTP body spells the fields
`device` and `class`; the CLI `--device` and `--class`; MCP and the client
use the contract's names.

### 2. The OS constraint is one string, parsed at the boundary

`osVersion` stays a string. A bare version is exact. A range is the
node-semver subset the feature names: the comparators `>=`, `>`, `<=`, `<`,
several joined by spaces, and the hyphen range `A - B`. A partial version
covers its prefix as node-semver reads it.

One module, `os-range` in `src/contract/`, owns the grammar: it parses a
string into a constraint, tests whether a version satisfies it, and orders
versions. It sits in the contract because the contract schema refines
`osVersion` through its parser, so a malformed range is `BAD_REQUEST` on the
socket, MCP and HTTP, with a message that names the accepted forms, and the
contract imports nothing from the core (ADR 0003 §1). The core and the
gateway import it from there. Nothing else in the tree parses a range or
compares versions for this feature; the drivers' own version helpers stay
private to them. No dependency is added.

### 3. A model's class is a catalog fact, derived by the driver

`platformCatalogSchema` gains `modelClasses`, a required record with an entry
for every name in `models` whose class the tooling reports. A model without
an entry belongs to no class and is leased by its exact name only; that is
how a product family or a tag this record does not know stays leasable. The iOS driver reads the device type's
`productFamily`; the Android driver reads the profile's `Tag :` line and maps
`android-tv`, `android-wear`, every `android-automotive*` tag and
`android-desktop`; an untagged Android profile is `phone`. No class is
derived from a name or a screen size, so on Android `tablet` holds no model.

On a gateway the fleet catalog's `modelClasses` is the union over connected
workers, one class per name as on a worker. When two workers class one name
differently, the fleet entry keeps the class of the first worker in id
order, so that name is listed under one class only; the worker list shows
each worker's own. Routing matches per worker and is not affected.

A device record stores no class. The class of a device is
`modelClasses[device.spec.model]` in the catalog of the worker that holds it,
looked up at the moment a fit is decided. A record written before this change
needs nothing.

### 4. The default model per class is a preference list, merged once

Each driver carries a built-in list per class, newest first, of models the
platform's tooling ships. The config keys `ios.defaultModels.<class>` and
`android.defaultModels.<class>` take one model name or a list and go in front
of the built-in list. The composition root merges the two into one map,
platform to class to ordered names, and hands it to the core the way it hands
`defaultModes`. The core never holds a model name of its own.

A name on the list counts on a host only when the catalog lists it, by name
or alias in any letter case, and classes it as that class in
`modelClasses`. A configured name that is not a model of the class is
skipped like any other, so `defaultModels` can never make a class create a
device of another class. The effective default for a class is the first
counting name that pairs with at least one installed runtime, or, when none
pairs, the first counting name. The catalog reports it in a new
`classDefaults` record, keyed by class, with no entry for a class in which
no name counts. A gateway's catalog carries an entry only when every
connected worker reports the same one, as `defaultRuntime` does; the worker
list shows each worker's own.

### 5. The core resolves a request into a requirement and a create spec

`LeaseAcquisitionCoordinator` resolves a request, once and before planning,
into two things.

The **create spec** is the `DeviceSpec` a new device would have.

- An exact model with an exact or absent version resolves as today: the
  driver's `resolveSpec` picks the runtime.
- An exact model with a range: the model must be one the catalog lists, by
  name or alias in any letter case, or the request fails at once with
  `UNKNOWN_MODEL`, as it would on a worker today. The runtime is the newest
  entry of the catalog's `modelRuntimes` for that model that satisfies the
  range, chosen by `os-range`. With none, the request fails at once with
  `RUNTIME_MISSING` and `downloadable: false`, whatever `allowDownload` says.
- A class: the candidates are the names on the class's list that count on
  this host (§4). With none, the request fails at once with
  `UNKNOWN_MODEL`, and the message names the config key for the platform
  and class. The model is the first candidate that pairs with a runtime
  satisfying the OS constraint, and the runtime is the newest such pairing;
  an absent constraint is satisfied by every pairing. With no candidate
  pairing, the request fails at once with `RUNTIME_MISSING` and
  `downloadable: false`.

A pairing is an entry of `modelRuntimes` for the model. When the request
names an image tag, only the runtimes for which the catalog's `images` lists
an image of that tag count, the rule the gateway's `matchRequest` already
applies.

The core then calls `resolveSpec` with that exact model and version, so a
driver never sees a class or a range, and ADR 0008 §3 guarantees the pairing
it is asked for is one the driver accepts.

The **requirement** is what an existing device must satisfy: the platform;
the model, by the catalog's own name, or the class; the OS constraint; the
mode; the image tag. The OS constraint is the request's range when it named
one. When it named none, an exact-model requirement is the create spec's
version, so an exact request fits what it fits today; a class requirement
is any runtime the catalog lists as installed. The mode is the one ADR 0007 §4 decided for this request,
the create spec's pool mode, so a slim request a driver cannot slim fits
full devices, and a `full` request fits only full ones (§5 there).

Failing before planning is deliberate: a request the host cannot create is
refused in one round trip, as an exact request is today, even when an idle
device of the class fits. The preference list makes that case rare, and
through a gateway ADR 0009 §5 carries the refusal to the next worker.

### 6. One function decides whether a device fits, and the planner reads it

`fits(requirement, spec, classOf)` lives in the core beside `sameSpec`. It
holds when the platform is equal; the model is equal, or `classOf` says the
device's model is the requested class; the device's `osVersion` satisfies
the constraint; the image tag is equal or both absent. It does not read the
mode: the worker's planner compares the device's pool mode with the
requirement's beside it, and the gateway applies ADR 0009 §6 (§8 below),
because no status response carries a pool mode (ADR 0007 §9).

`AcquisitionPlanner.plan` looks for a `ready` device that fits in the
requirement's mode, then a `shutdown` one, then provisions the create spec.
`sameSpec` is untouched and still names pool identity everywhere else: the
warm pool, reclaim, the idempotency check. Among several devices that fit,
the first in snapshot order is taken; nothing promises which.

### 7. The grant and the device record do not change

A grant always names the concrete model, OS, mode and image tag of the device
it hands over, from the record, as today. `device.provisioned` carries the
create spec. No response or record carries a class or a range. The events
that do are the three that describe the request itself (§9).

### 8. The gateway forwards what it got and matches with the same functions

A gateway forwards `class` and the `osVersion` string untouched; only an
exact model is replaced by the worker's own name, as ADR 0009 §3 says. The
worker applies §5 and §6 itself, so a warm device of another model in the
class is still found there.

`matchRequest` reads the class the request means (§1) and `os-range` from
the contract, `modelClasses` from the view, and the fit from the core: a worker can serve a request when its catalog
lists the model, or any model of the class, paired with an installed
runtime that satisfies the constraint. The ADR 0009 §4 table keeps its rows,
and each gives the code §5 gives on a worker: row 3 is "no known worker
lists the model, or any model of the class", row 4 is "none pairs one with
a runtime satisfying the constraint".

The `warm-hit` stage calls the core's `fits` over the worker's `ready`
devices, with that worker's catalog as `classOf`, and keeps ADR 0009 §6 for
the mode: `full` needs `mode: "full"`, `slim` needs `mode: "slim"`, none
needs `servesDefaultMode`. §6's rule for an unnamed runtime stands for an
exact model with no version; a class with no version fits any, as on the
worker. The gateway compares versions only to evaluate a range.

A worker whose class default is misconfigured still passes `can-serve` when
it lists a model of the class; its `UNKNOWN_MODEL` is a refusal ADR 0009 §5
already retries elsewhere.

### 9. Events change by one key, and `model` turns optional

`lease.requested` and `lease.rejected` carry the request as it arrived, so
`requestSpec` gains `class` and a range where the request named them, and
has `model` only when the request did. `request.dispatched` gains optional
`class`, and its `model` becomes optional for the same reason. Making a
required key optional is not additive under events rule 6. This record
takes that exception once, while the package is 0.x, as ADR 0007 §13 did,
and the note at the top of `EVENTS.md` records it. No event is added or
removed.

### 10. The wire changes without a shim

Each task that changes a request, response or catalog shape raises the
protocol version by one, as ADR 0007 §12 says. Four of the five tasks do.

## Consequences

- An agent asks for what its test needs, a class and a version floor, and
  gets whatever fitting device is warm before anything is created.
- The core reads the catalog on every request that names a class or a range,
  one more `simctl list` or `avdmanager` run per request on top of the one
  `resolveSpec` already makes. Neither driver caches the catalog; a cache is
  a later change if the cost shows.
- The create pick for a class follows the preference list, so a bad
  `defaultModels` value, unlisted, of another class or unpaired, is skipped,
  not fatal. The only way to see that it was skipped is `simlock catalog`,
  which shows the effective default; under an OS range or an image tag the
  pick can still land further down the list than the catalog shows.
- Android `tablet` holds no model, and `android.defaultModels.tablet` cannot
  change that, since a name that is not of the class never counts: a
  `--class tablet` Android request fails with `UNKNOWN_MODEL` until the
  tooling tags tablets.
- The gateway imports the fit and catalog-match functions from the core, the
  class and range functions from the contract, and keeps one rule of its own, the mode rule of ADR 0009 §6, because status
  carries no pool mode. Task 194 of #173 lands that rule; the gateway task
  of #326 builds on it.
- A device's class changes if the host's tooling changes what it reports for
  the model. Nothing is stored, so nothing goes stale.
- Four protocol bumps across five PRs.
- The docs change with the implementation. Each task updates the docs it
  makes true.

## Alternatives considered

- **Store the class on the device record.** One lookup fewer at fit time.
  Rejected: a new stored field, a migration for every existing record, and
  two sources for one fact.
- **Let `resolveSpec` take a class and a range.** The driver already loads
  the catalog once per request. Rejected: the class pick and the range pick
  would exist in two drivers and two fake drivers, and the gateway would
  still need its own copy to route.
- **Add the `semver` package.** Rejected: the subset is small, its
  partial-version rule is the only subtle part, and a dependency would
  accept forms the feature excludes.
- **Resolve the create spec only when nothing idle fits.** A warm device
  would rescue a misconfigured default. Rejected by the maintainer in
  favour of the preference list, which makes the case rare, and of failing
  in one round trip when it does happen.
- **A single default model per class, no list.** Rejected by the maintainer:
  a host without the newest model should drop to an older one, not fail.
- **`can-serve` requires the worker's effective default to pair.** Stricter,
  but it would drop a worker holding a warm fitting device, and the refusal
  retry already covers the loose rule's miss.
- **A gateway catalog that shows every worker's default per class.**
  Rejected: `defaultRuntime` already settled that a disagreeing fleet shows
  nothing, and the worker list carries each worker's own catalog.
