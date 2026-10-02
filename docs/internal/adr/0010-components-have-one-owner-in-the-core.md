# 0010. Components are installed, recorded and removed through one owner in the core

- **Status:** Accepted
- **Date:** 2026-10-02
- **Issue:** [#208](https://github.com/callstackincubator/simlock/issues/208),
  [#209](https://github.com/callstackincubator/simlock/issues/209),
  [#213](https://github.com/callstackincubator/simlock/issues/213)
- **Supersedes:** nothing. Narrows [ADR
  0005](0005-gateway-and-worker-modes.md): requirement 7 (the worker view
  keeps a third config value, `downloads.timeoutMs`, and is also refreshed on
  component events), requirement 20 (`status.get` gains `installs`) and
  requirement 23 (one more gateway-only operation). Narrows [ADR
  0009](0009-gateway-routing-is-a-list-of-stages.md): its consequence that
  `--allow-download` does nothing through a gateway "until the downloads
  feature is specified" becomes permanent (§7). Changes safety rules 1 and
  4; each changes in the task that makes its new text true (§4, §8).
- **Amended:** §8 by
  [#241](https://github.com/callstackincubator/simlock/issues/241), before
  it was implemented, on the maintainer's decision: a foreign device counts
  as a user when the driver says it is one, and never-used iOS simulators do
  not.
- **Depends on:** ADR 0003 (the contract), ADR 0005 (the gateway), ADR 0008
  (the catalog).

## Context

A component is an iOS simulator runtime or an Android system image. Simlock
installs one only as a side effect of a lease request that allows a
download. Each driver decides that inside `resolveSpec`, runs the installer,
joins concurrent callers on its own lock, checks free disk, and reports
through diagnostics. Four faults follow.

- An operator cannot install a component without leasing a device.
- The same decision lives in two drivers. The join key is the exact command
  line, so the same iOS runtime asked for as "newest" and by version can
  download twice.
- `component.installed` is reported once per request that waited, not once
  per install.
- The core does not know which installs are running or which components
  Simlock installed. A gateway cannot show the first, and safety rule 1
  forbids removing anything without the second.

## Decision

### 1. A component is a platform and a version

The version is the string the catalog lists under `runtimes`: `26.4` for an
iOS runtime, `35` for an Android API level. The core carries it unread. Which
image variant an Android version means is the driver's choice.

### 2. Drivers install; they do not decide

`resolveSpec` never downloads and loses its `allowDownload` option. When a
download could satisfy the request, it throws `RuntimeMissingError` with
`downloadable: true` and `component`, the string to install. The driver may
name something broader than a version there, such as its word for "newest";
the core hands the string back unread.

The driver gains two verbs.

`findComponent(component)` is a read. For a version it answers with the
exact version and the receipt (§5) of the installed component, or with
nothing. For a string that is not a version, such as "newest", it answers
with nothing: only the installer run can tell. It never downloads.

`installComponent(component, { onProgress, signal })` runs the platform
installer, verifies the result against a fresh read, and returns the exact
version now installed, its receipt, and whether the run installed it: the
outcome is `installed` when that receipt was not there before the run, and
`already-installed` when it was. It ends the installer when `signal` fires.
It does not join callers, check disk, emit events, or read policy.

The driver states the disk an install needs as a fixed estimate and the path
it lands on. Neither platform installer reports a size before it downloads.

### 3. One installer in the core

`ComponentInstaller` is the only caller of `installComponent`. The lease path
and the install operation both go through it.

When a call reaches the front of its queue the installer first asks
`findComponent`. Found: the call ends as `already-installed`, with no
reservation and no event. Not found: it reserves disk, emits
`component.install-started`, and calls `installComponent`.

- **One install per platform at a time,** first come first served. iOS and
  Android installs may run together.
- **Same component, one install.** A call for a platform and the same
  component string that is running or waiting joins it. Every joined call
  gets that install's outcome or its error. A call that names the component
  differently, "newest" beside a version, does not join: it waits its turn
  and checks again, as below.
- **A call that waited checks again.** A caller may pass a check that says
  whether it still needs the install. The installer runs it when the call
  reaches the front, and skips the install when the need is gone. The lease
  path passes "does `resolveSpec` still fail".
- **Disk is reserved, not just checked.** The installer reserves the driver's
  estimate with `DiskSpaceGuard` for as long as the install runs. An install
  that does not fit beside the running ones is refused before it starts.
- **Every call has one budget:** `downloads.timeoutMs`, measured from the
  moment the call arrives. It covers waiting and downloading and does not
  restart when the download starts. A call still waiting when its budget
  ends fails with `DOWNLOAD_TIMEOUT` and leaves the queue. A running install
  is ended at the deadline of the oldest call joined to it, and every call
  joined to it gets `DOWNLOAD_TIMEOUT`.
- **Events once per install.** The installer emits
  `component.install-started`, then `component.installed` or
  `component.install-failed`, once each, whatever the number of joined
  calls. A call that ends before the installer runs, as not needed or
  `already-installed`, emits nothing. When the installer ran and found the
  component already there, `component.installed` carries `alreadyPresent:
  true`.
- **Progress** from the driver goes to every joined call.
- **On daemon stop** the installer ends the running install and rejects the
  waiting ones. Nothing is resumed on the next start.
- **Installs in progress are in status.** `status.get` lists each install
  that is waiting or running: platform, component, state, since when, and
  how many calls wait on it. It is the one source for a gateway and for
  `simlock status`. A lease is not: a download ends before a lease exists,
  and an install command has no lease.

### 4. Consent

One function, `effectiveAllowDownload(policy, requested)`, answers whether a
download may start. A lease request passes its own flag. The install
operation passes `true`: the command is the consent. So:

| `downloads.policy` | Lease without the flag | Lease with the flag | Install operation |
|---|---|---|---|
| `never` | refused | refused | refused |
| `on-request` | refused | allowed | allowed |
| `always` | allowed | allowed | allowed |

`never` is absolute. No role and no operation overrides it.

Warm-pool provisioning and startup convergence never reach the installer.
Android license consent stays its own key, `downloads.acceptAndroidLicenses`.

Safety rule 4 is rewritten to say this, in the task that adds the install
operation.

### 5. Simlock records what it installed

When the driver reports `installed`, the installer stores a component record
in the registry: platform, version, time, and the driver's receipt.
`already-installed` stores nothing, whether `findComponent` or the installer
run found it.

A receipt names the installed thing itself, not its version, and differs
for every install: the runtime image identifier and its build on iOS; on
Android the package, its revision, and a stamp of the image's own metadata
file (which file it is and when it was written). The
core compares receipts for equality and reads nothing in them. One function
in each driver builds a receipt, for an install and for a listing alike.

A component is Simlock's when a record's receipt equals the receipt of
something installed now. That is the only proof (safety rule 8). A component
with no such record is never removed (safety rule 1), whoever asks. A record
that matches nothing claims nothing: a component the user deleted and
installed again has a new receipt and is the user's.

### 6. The install operation

`component.install` is an admin operation with input `{ platform, version }`.
It answers with the outcome and the exact version installed. Progress
arrives as request-scoped pushes while it runs.

It is not durable. A daemon stop ends the install and the restart forgets
it. Running it again is the recovery: it starts the install again, or finds
the component installed.

Over HTTP it is one request whose response is an event stream, the shape
`POST /v1/leases/{id}/exec` already has. A dropped connection does not stop
the install, and a repeat of the request joins it.

### 7. Through a gateway

A gateway owns no components. A gateway-only operation,
`worker.install-component`, takes a component and the workers to install it
on: a list of worker ids, or all. The gateway asks every targeted worker at
the same time with `component.install`, and each worker answers for itself
under §3 and §4. The answer is one result per worker.

- A drained worker is asked like any other connected worker.
- Under "all", a worker that is disconnected, incompatible, or whose config
  has not been read is skipped and listed as skipped. A named worker in that
  state fails the whole call before anything is asked.
- The gateway keeps no request for a worker that is away and never retries.
- The worker's budget is the limit. The gateway only adds a backstop for a
  worker that never answers: that worker's own `downloads.timeoutMs`, read
  with its config, plus one minute. There is no gateway key for it. When the
  backstop passes or the uplink drops, the worker's result is `unknown` and
  its install carries on.
- A gateway has no download policy of its own. `component.install` itself
  stays unsupported on a gateway.

The gateway's worker view copies each worker's installs from its status
(§3) and is refreshed on the worker's `component.install-*` events.

A gateway never asks for a download. It sends a lease request only to a
worker whose catalog has the runtime, and forwards `allowDownload: false`
(ADR 0009 §3). That was a stopgap in ADR 0009; it is now the rule. One case
remains: a worker whose own policy is `always` downloads for any lease
request, so it may download when its catalog changed after the gateway last
read it. That is the worker operator's own consent (§4).

### 8. Listing and removal

`component.list` is a read for any session. It lists every installed
component with its size, whether it is Simlock's (§5), and how many devices
use it: Simlock's own, from the registry, and foreign ones, counted by the
driver. Simlock's own are counted by platform and version, so two variants
of one version show the same count. Removal therefore errs towards
refusing.

Counting foreign devices is the only place a driver looks at devices that
are not Simlock's: the platform's default device set on iOS, the user's own
AVD home on Android. It reads them and never writes there.

A foreign device counts as a user when the driver says it is one. On Android
that is every AVD in the user's AVD home. On iOS it is a simulator in the
default set that has been used at least once: when a runtime install ends,
macOS creates a batch of unused simulators for it by itself, and counting
them would make every runtime Simlock installs unremovable ([#241](https://github.com/callstackincubator/simlock/issues/241)).
One driver function decides this for the listing and the removal alike.
The unused simulators are left in place: removing the runtime makes them
unavailable, and the result reports how many there are and how to clear
them. Simlock deletes none of them.

`component.remove` is an admin operation. It removes a component only when
all of these hold:

- it is Simlock's (§5);
- no device Simlock can see uses it: none of its own in any state but
  `deleted`, and no foreign one the driver counts as a user, running or not;
- no install is running or waiting on that platform.

The check and the removal cannot be split by a new Simlock device. The installer
marks the component as being removed inside the serialized decision gate,
and no device record is created for it until the removal settles. The
removal holds the platform's turn, so an install waits behind it. A foreign
device created after the driver's last count is not seen.

The driver gains `removeComponent(receipt)`. It proves the receipt again,
counts foreign devices again, removes, and verifies. When something stays on
disk it says so: an iOS runtime's unused simulators, now unavailable, and its
download, which can outlive `simctl runtime delete` (#79). Simlock asks `simctl` to delete the runtime and reports what
`simctl` left; it never deletes a file in the macOS asset store itself.

A dry run does every check a removal does and removes nothing. The CLI confirms or requires
`--yes` (safety rule 5). `component.removed` names the component and who
asked (safety rule 6).

Nothing removes a component on its own: no cleanup rule, idle tier, or
disk-pressure reaction.

Safety rule 1 is rewritten to say this, in the task that adds removal.

### 9. The wire

The protocol moves from 8 to 9 once, with no shim, in the task that adds
`component.install`. A gateway relays that operation to workers, and a
worker without it must be `incompatible` rather than fail in the middle of
a relay.

Nothing else here moves it. An operation no gateway relays
(`worker.install-component`, `component.list`, `component.remove`), an
optional field, and a new error code are additions a peer on 9 does not
depend on.

## Consequences

- Both drivers lose their download locks, their disk checks and their
  component diagnostics. A third driver gets installs by implementing the
  two verbs and stating its estimate.
- A lease request for a second missing runtime on the same platform now
  waits for the first download to finish. It used to run beside it.
- `component.installed` fires less often than before: once per install.
- A component installed before this lands has no record and is never
  removed by Simlock.
- A second Simlock instance on the same machine is not counted as a user.
  Its devices live in its own root, which this instance cannot see.
  Removing a component it uses breaks its devices until the component is
  installed again. Accepted, and recorded in `KNOWN-PITFALLS.md` by the
  removal task.
- One forgotten simulator in Xcode that uses a runtime blocks its removal
  until the user deletes that simulator.
- Removing an iOS runtime may free no disk. The result and the existing
  `runtime-cache-unreclaimable` advisory say so.
- A daemon stop during a download throws the download away.
- A call that waits behind another download has less time left for its
  own. On a busy machine the operator raises `downloads.timeoutMs`; its
  default stays 20 minutes.
- An operator who wants a locked-down machine sets `downloads.policy:
  "never"` and installs with the platform's own tools.

## Alternatives considered

- **Keep the download inside each driver and add an install verb beside
  it.** Smaller. Rejected: joining, events and progress stay written twice,
  and the core still cannot say what is installing or what it installed.
- **One download per component, in parallel.** Faster when preparing a
  machine. Rejected: "newest" and an explicit version can still be the same
  runtime, and two `sdkmanager` runs share one SDK directory.
- **A durable install with an operation id that resumes after a restart.**
  This is what #78 asked for. Rejected: the installers cannot resume, so
  the daemon would only be replaying a request the operator can repeat.
- **Let an admin install override `downloads.policy: "never"`.** Rejected by
  the maintainer: one key must be able to lock a machine down completely.
- **A gateway key for the relay's time limit,** like `gateway.execTimeoutMs`.
  Rejected by the maintainer: the limit belongs where the download runs,
  and the gateway can read it from the worker.
- **Learn about downloads from leases.** Rejected: see §3.
- **Remove a runtime while the user's own simulators use it,** since Simlock
  installed it. Rejected by the maintainer: nothing of the user's stops
  working because of Simlock.
- **Wait until iOS removal is proven to free disk.** Rejected by the
  maintainer: removal ships for both platforms and reports what stayed.
- **Reserve disk by the real size.** Rejected: neither installer reports it
  before the download starts.
