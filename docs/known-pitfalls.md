# Known pitfalls

## Orphaned lease holders (resolved)

The primary lease mechanism is process-held: `simlock lease` runs in the
background, holds an open socket to the daemon (connection-alive acts as the
heartbeat), and the agent kills the process to release the lease.

**The pitfall:** if the agent crashed or was killed, its backgrounded `lease`
process did *not* die with it — it got reparented (to launchd on macOS) and
kept the socket open, holding the lease indefinitely. This silently
reintroduced the "crashed agent holds a device forever" problem the tool
exists to solve, and it blocked CLI held mode from declaring the heartbeat
capability: a reparented holder is alive and would answer heartbeats
forever, which would have turned the bounded TTL-backstop leak into an
unbounded one.

**Fix:** the holder watches its parent through the `ParentWatch` port
(`src/ports/parent-watch.ts`) and self-terminates the moment that parent
dies — releasing its lease and exiting through the exact same signal path
`runLease` already uses for SIGINT/SIGTERM, not a separate shutdown path. The
watched pid is captured at startup; `--bind-pid <pid>` overrides it for a
holder spawned from a short-lived subshell, where the immediate parent dies
even though the owning agent is still alive.

The plan called for macOS `kqueue`/`EVFILT_PROC`/`NOTE_EXIT` and Linux
`prctl(PR_SET_PDEATHSIG)`. Neither is reachable from plain Node without a
native addon, which this package does not take on, so the shipped adapter
(`NodeParentWatch`) instead polls `process.kill(pid, 0)` for liveness —
portable across platforms with no native dependency. It satisfies the same
`ParentWatch` port a future native adapter would, so replacing it later
touches only that one file. CLI held mode now declares the `heartbeat`
capability, same as MCP.

Machine sleep and zombie sockets still fall back to the daemon-side TTL
backstop; this fix is about a holder outliving its owner, nothing more.

## Crash recovery cannot restore in-device session state

`LeaseHealthMonitor` reboots a leased device whose process died outside
simlock and hands the same lease back to its holder, so the device and its
on-disk state — installed apps, written data — survive the crash intact.

**The pitfall:** anything the agent had running *inside* the device died with
the process and a reboot cannot bring it back: a launched app, a `log
stream`, an Appium/XCUITest session, a port forward. Simlock has no visibility
into what was running there, so it cannot even enumerate what was lost, let
alone restore it. This is why recovery notifies the holder
(`device-unhealthy` / `device-recovered` in held mode) rather than healing
silently — the agent has to notice and re-establish its own session state.

Detection also has residual latency by design: a crash isn't declared until
`health.stableObservations` consecutive `stopped` observations, spaced
`health.probeIntervalMs` apart, so the worst case before the holder is told is
roughly `probeIntervalMs * stableObservations` (30s and 2 observations by
default, so up to ~60s). This debounce is deliberate — `simctl` reports
`Booting`/`Shutting Down` and an emulator reads offline in `adb devices`
before it answers `getprop`, and either would misfire as a crash without it.

A device erased or deleted outside simlock is a different, unrecoverable case:
recovery detects the provenance drift (the same check `doctor` runs) and
releases the lease as `device-lost` rather than rebooting it, because the
disk state a reboot would resume is no longer provably the agent's. The
device returns to the pool for someone else; the lease that lost it does not
get its device rebuilt.

**Status:** known and accepted. This is the intended boundary of crash
recovery, not a bug — restoring in-device session state would require
simlock to understand and reproduce whatever the agent was doing inside the
device, which is out of scope for a device control plane.

**Possible future fix:** none planned. An agent that needs resilience to this
should treat `device-unhealthy` as a signal to re-establish its own session
rather than assume continuity.

## Warm-pool purge failures (resolved: quarantine, #21)

Before a released device enters the warm pool, Simlock attempts to purge the
previous lease's state. A successful purge produces a clean, ready device.

**The original pitfall:** the first warm-pool version emitted
`device.purge-failed` but still left the device running and eligible for
another lease. The next agent could silently inherit apps, data, or other
state left by the previous lease — indistinguishable from the app itself
misbehaving.

**Fix (#21):** a failed purge now commits the device to `quarantined` instead
of readiness-checking it back into circulation. `quarantined` is a shared
"present in the registry, counts against running capacity, not grantable"
disposition (see `docs/ARCHITECTURE.md`, "Quarantine: present but not
grantable") — `AcquisitionPlanner` and the warm-pool eviction helpers select
targets by exact state, so a quarantined device is simply invisible to every
grant path with no special-casing required. `QuarantineCoordinator` retries
the purge on a `Clock`-driven backoff (`warmPool.quarantine.{maxRetries,
retryBackoffMs,retryBackoffMultiplier,maxRetryBackoffMs}`); a successful
retry returns the device to the warm pool, and exhausting the retry budget
destroys it (registry-only, as always). The device stays visible as
`quarantined` in `simlock status` and `simlock list --devices` throughout.
`device.purge-failed` still fires as before; `device.quarantined`,
`device.quarantine-recovered`, and `device.quarantine-abandoned` are the new
follow-up facts (see `docs/EVENTS.md`).

## Component downloads: per-request blocking, the bounded-default edge case, and no progress push

The iOS driver's `resolveSpec` (`src/drivers/ios/index.ts`) can now run
`xcodebuild -downloadPlatform iOS` when a requested runtime is missing and
downloads are permitted. Two things worth knowing about that path:

**Only the requesting lease waits.** `resolveSpec` runs inside
`LeaseAcquisitionCoordinator#resolveAndDrive`, per request, outside the
serialized decision gate and outside the FIFO head — a slow download (tens
of minutes for a ~7 GB runtime) blocks only the request that triggered it.
Concurrent requests for the *same* missing runtime are deduped behind an
in-driver promise (one `xcodebuild` invocation, all callers await it); a
request for a different model or version proceeds independently and is
never queued behind someone else's download.

**The bounded-default edge case.** When no `--os` is given and no installed
runtime pairs with the model, the driver has to guess a version to
download: unbounded models (no `maxRuntimeVersion` cap) get a plain
`-downloadPlatform iOS` (latest), but a model with a bounded max (like an
older device type whose newest compatible runtime is a specific release)
gets `-buildVersion <major from maxRuntimeVersion>` — just the major
version number, since the exact patch release isn't known offline (Apple's
downloadables index isn't parsed in v1; see `docs/IDEAS.md`). If Xcode
doesn't have a build matching that bare major version, the download fails
and the caller is told to pass `--os <version>` explicitly rather than
retrying blind.

**No requester-visible progress during a download (#67 stage 4).** The
requester's lease-progress stream (`LeaseProgress` in `src/core/wait-queue.ts`
— `queued` / `provisioning` / `booting` / `reclaiming`, relayed as CLI stderr
JSON lines and MCP `notifications/progress`) has no `downloading` stage. Both
drivers' `resolveSpec` — where a runtime or system-image install actually
happens — runs before `LeaseAcquisitionCoordinator#drive`'s provisioning
step, and `Driver.resolveSpec`'s signature carries no progress callback the
way `provision`/`makeReady` do. A held-mode CLI or MCP caller waiting on a
multi-minute install today sees nothing on the wire between its request and
either the eventual grant or a timeout; the only visibility is the daemon's
own `component.install-started` bus event (`simlock events --follow`) and log
line, neither reaching the waiting connection itself. Threading a
`downloading` stage through would mean widening the `Driver` interface
(`resolveSpec` gaining an `onProgress`-shaped option, both drivers
implementing it), a new `LeaseProgress` variant, and CLI/MCP wire changes —
real protocol machinery, not a small addition, so it was deliberately not
built in stage 4. `component.install-started`'s payload already carries
enough (`platform`, `componentId`) that a future pass wiring this through
would mostly be plumbing, not new information to invent.

## iOS slim mode: accepted costs and feature loss (#87)

`ios.slim` (opt-in, default off) has the iOS driver disable ~170 launchd
daemons across simulator daemon categories to cut RAM/CPU footprint (see
[CONFIGURATION.md](CONFIGURATION.md)). It carries four trade-offs worth
knowing before turning it on.

**Every reclaim pays two boots, indefinitely.** `IosSimctlDriver.reclaim`
always runs `simctl erase`, which wipes the simulator's data partition —
including the launchd overrides slimming wrote there. So a reclaimed device
is never still slim: the next `makeReady` re-applies the full disable pass
and reboots twice (once to boot the freshly erased device, once more for the
overrides to take effect) rather than skipping straight to the idempotence
check. Accepted because both reclaim and warm-pool provisioning run off the
lease-granting critical path — the requester waiting on a device only pays
for this when nothing pre-provisioned was available. A non-erasing
`standard` clean level, if one is added later, would let a reclaimed device
stay slim and remove this cost; no such level exists today.

**Runtimes older than iOS 18.5 silently get nothing.** `launchctl disable`
overrides only persist across a reboot on iOS 18.5+; older runtimes accept
the commands and drop them on the post-slim reboot, so slimming would cost a
second boot for no effect. `planSlimBoot` (`src/drivers/ios/index.ts`) gates
on this and skips the apply pass entirely rather than paying that cost —
silently, from the requester's point of view: the lease still grants, just
with `slim: false`. `simlock doctor`'s `driver-advisory` /
`slim-runtime-unsupported` finding is what makes an unsupported runtime
visible to an operator instead of it only ever showing up as an unexpectedly
non-slim lease.

**Slim devices lose features that depend on the disabled daemons.** Expect
push notifications, Spotlight/on-device search, StoreKit/App Store sheets,
universal links, Siri/Apple Intelligence, iCloud sync, and some system
pickers to not work on a slim device — the categories that back them are
exactly the ones slimming disables. Mitigations: `simlock lease --full` (MCP
`full: true`, HTTP `full: true`) opts a single lease out of slimming, and
every lease response carries a `slim` flag so a caller can tell a
feature-loss failure apart from an actual bug instead of guessing.

**Mixing slim and full devices under one spec can make `--full` wait or
re-provision.** `full` is part of spec identity (`DeviceSpec.full`, compared by `sameSpec`,
see [ADR 0002](adr/0002-opt-in-slim-ios-simulators.md)), so a `--full`
request never matches a slim device sitting warm in the pool — even when one is idle and a
match on model/os alone would otherwise be instant. Depending on capacity,
that means either queueing for a fresh device to provision or forcing a
re-provision of a device already running. This is inherent to keeping pool
matching from fragmenting on driver-level settings, not a bug to fix.

**A cold slim lease outlives a default MCP request timeout.** Measured on
one machine: a `--full` cold lease took ~28s, a cold slim lease ~160s (two
real boots plus the disable pass). The MCP SDK's default per-request timeout
is 60s, so an MCP client that does not reset its timeout on progress
notifications gets `MCP error -32001: Request timed out` on the slim lease
even though the daemon completes it. Simlock relays boot progress as MCP
progress notifications precisely so clients can pass
`resetTimeoutOnProgress: true` (or a longer timeout) on `lease_simulator`;
`e2e/slow-ios-slim.test.ts` shows the call shape. The warm pool hides this
for every lease after the first.

**`launchctl disable` accepts labels that do not exist.** Verified on iOS
26.4 and 27.0 simulators: disabling `system/com.apple.does.not.exist` exits
0 and writes the entry to the override database like any other. So the
per-label `simlock-slim-failed` channel (and the `unknownLabels` field of
`device.slimmed`) reports labels the shell-safety filter rejected or a
`launchctl` that crashed, never a daemon Apple has renamed or removed. Drift
in the label list is invisible at apply time; the only signal is a slim
device that is not as slim as expected. Re-sync `slim-labels.ts` against
upstream simslim per iOS major. Newer runtimes also print a deprecation
warning asking for `user/foreground/<label>` instead of `system/<label>`;
the `system/` form still takes effect and is what simslim uses.

**Narrowing `ios.slim.categories` does not re-enable anything on existing
devices.** There is no `launchctl enable` pass anywhere in the driver. When an
operator removes a category from `ios.slim.categories`, the signature that
gates re-applying the disable pass changes, so an existing device re-applies
the now-narrower set on its next boot — but the `launchctl disable` overrides
already written for the *removed* category are never undone. They live in the
simulator's own launchd database and only disappear on `simctl erase`. The
device keeps reporting `slim: true` and keeps missing that category's
functionality, with no error surfaced anywhere. The real consequence is
stronger than the flag alone suggests: the device ends up slimmer than *any*
configuration ever asked for — it carries both the newly-narrower disable set
it just re-applied *and* the leftover overrides from the wider set it was
slimmed under before, a combination no `ios.slim.categories` value on its own
would ever produce. Workaround: after narrowing the category list, reclaim
(or destroy) every device already running under the old, wider set before
relying on the change — a plain reboot is not enough.

**Turning `ios.slim.enabled` off leaves orphaned `--full` devices sitting in
the pool.** `full` only earns its own pool key while the driver might
otherwise hand back a reduced device (`Driver.reducesFeatures`); once slim
mode is off, no newly resolved spec ever carries `full: true` again. A device
that was provisioned for a `--full` request while slim mode was on keeps
`full: true` on its spec in the registry, so it can no longer match anything
a resolver produces — it becomes unmatchable by any new request. This is not
a permanent orphan: the idle-shutdown and idle-destroy cleanup rules reap it
on the same timers as any other idle device, since neither rule cares what a
device's spec matches. Until those timers fire, though, it occupies a pool
slot doing nothing.
