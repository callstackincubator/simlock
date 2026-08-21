# Known pitfalls

## Orphaned lease holders (resolved)

The primary lease mechanism is process-held: `pitlane lease` runs in the
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
