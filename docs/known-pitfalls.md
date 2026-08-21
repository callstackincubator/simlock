# Known pitfalls

## Orphaned lease holders (deferred from v1)

The primary lease mechanism is process-held: `pitlane lease` runs in the
background, holds an open socket to the daemon (connection-alive acts as the
heartbeat), and the agent kills the process to release the lease.

**The pitfall:** if the agent crashes or is killed, its backgrounded `lease`
process does *not* die with it — it gets reparented (to launchd on macOS) and
keeps the socket open, holding the lease indefinitely. This silently
reintroduces the "crashed agent holds a device forever" problem the tool
exists to solve.

**Status in v1:** known and accepted. The daemon-side long TTL backstop is the
only safety net, and it is intentionally long, so an orphaned holder can block
a device for a while. `pitlane doctor` / manual force-release is the recovery
path.

**Planned fix (post-v1):** the holder process watches its original parent and
self-terminates when it dies:

- macOS: `kqueue` with `EVFILT_PROC` / `NOTE_EXIT` on the parent PID captured
  at startup.
- Linux: `prctl(PR_SET_PDEATHSIG, SIGTERM)`.

Edge cases the fix must still consider: the agent may spawn the CLI from a
short-lived subshell (parent dies immediately even though the agent is alive),
so the watched PID may need to be configurable (`--bind-pid <pid>`), and
machine sleep / zombie sockets still rely on the TTL backstop.

## Crash recovery cannot restore in-device session state

`LeaseHealthMonitor` reboots a leased device whose process died outside
pitlane and hands the same lease back to its holder, so the device and its
on-disk state — installed apps, written data — survive the crash intact.

**The pitfall:** anything the agent had running *inside* the device died with
the process and a reboot cannot bring it back: a launched app, a `log
stream`, an Appium/XCUITest session, a port forward. Pitlane has no visibility
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

A device erased or deleted outside pitlane is a different, unrecoverable case:
recovery detects the provenance drift (the same check `doctor` runs) and
releases the lease as `device-lost` rather than rebooting it, because the
disk state a reboot would resume is no longer provably the agent's. The
device returns to the pool for someone else; the lease that lost it does not
get its device rebuilt.

**Status:** known and accepted. This is the intended boundary of crash
recovery, not a bug — restoring in-device session state would require
pitlane to understand and reproduce whatever the agent was doing inside the
device, which is out of scope for a device control plane.

**Possible future fix:** none planned. An agent that needs resilience to this
should treat `device-unhealthy` as a signal to re-establish its own session
rather than assume continuity.

## Warm-pool purge failures (accepted in the first version)

Before a released device enters the warm pool, Pitlane attempts to purge the
previous lease's state. A successful purge produces a clean, ready device.

**The pitfall:** if that purge fails, the first warm-pool version emits
`device.purge-failed` but still leaves the device running and eligible for
another lease. The device continues to count against the running-device
limit. The next agent may therefore observe apps, data, or other state left by
the previous lease.

**Status in the first warm-pool version:** known and accepted. Purge failure
must be visible through the event stream so its frequency and impact can be
measured, but it does not quarantine the device or block acquisition.

**Possible future fix:** quarantine the device after a failed purge, retry
with backoff, or shut down/delete it after a configurable number of failures.
Revisit once real-world failure data shows which recovery policy is justified.
