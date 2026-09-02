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

## Device roots are an accident boundary, not a security boundary (planned)

> Status: describes the state after
> [ADR 0001](adr/0001-simlock-owned-device-roots.md) lands.

Simlock keeps its devices in roots it owns and scopes every platform command
to them, so Xcode, Android Studio, and a plain `simctl` / `adb` do not see
them. This is what makes ownership provable: nothing outside Simlock can put a
device in a Simlock root, so a device found there is Simlock's without needing
to guess from its name.

**The pitfall:** it is tempting to read that as isolation. It is not. A user
who passes `xcrun simctl --set <path>` or raises
`ADB_LOCAL_TRANSPORT_MAX_PORT` on their own adb server reaches straight into
the root. Nothing about the mechanism resists a *deliberate* actor — it only
makes accidental interference very unlikely, which is the actual goal, since
the thing being prevented is a developer or another tool wiping a device an
agent is mid-lease on.

This is exactly why the durable/erasable provenance marks survive the change:
they detect a device erased or deleted out from under a live lease, which
containment makes rare but cannot make impossible. Do not remove them on the
grounds that the root already proves ownership — the root proves *whose device
it is*, the marks prove *what happened to it*.

**Status:** accepted by design. Anything that needs a real trust boundary
(multi-tenant machines, untrusted agents) needs OS-level isolation, which is
out of scope for a device control plane.

## Simlock's adb server has to be supervised by pid (planned)

> Status: describes the state after
> [ADR 0001](adr/0001-simlock-owned-device-roots.md) lands.

Android containment needs Simlock to run its own adb server, because `adb` has
no equivalent of `simctl --set`. That server is started with
`ADB_REJECT_KILL_SERVER=1` so an agent's reflexive `adb kill-server` cannot
detach every leased emulator at once.

**The pitfall:** that protection applies to Simlock too. `adb kill-server`
against its own server returns `error: kill-server rejected by remote server`,
for the life of the process. The only way to stop it is to kill the pid.

So the pid is recorded in `~/.simlock/adb-server.json` when the server starts,
the daemon reaps it by pid on shutdown, and a daemon that crashed must find
that file on restart and adopt-or-kill the server it names. A stale entry — the
pid is gone, or belongs to something else now — must be treated as no server,
not as a server to kill blindly.

The file is deliberately *not* part of `state.json`: process supervision must
not depend on registry integrity, since a corrupt registry is exactly when you
would need to clean up a leftover server.

**Related:** unix-domain sockets are not available for the adb server on
macOS (`unix:`, `localfilesystem:`, and `localabstract:` are all rejected), so
this has to be a TCP port and cannot live as a socket file inside
`~/.simlock/` the way `daemon.sock` does. That is why
`drivers.android.adbServerPort` exists and why two Simlock instances on one
machine need distinct values for it.
