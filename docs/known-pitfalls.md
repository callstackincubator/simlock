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

## Warm-pool purge failures (resolved: quarantine, #21)

Before a released device enters the warm pool, Pitlane attempts to purge the
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
`quarantined` in `pitlane status` and `pitlane list --devices` throughout.
`device.purge-failed` still fires as before; `device.quarantined`,
`device.quarantine-recovered`, and `device.quarantine-abandoned` are the new
follow-up facts (see `docs/EVENTS.md`).
