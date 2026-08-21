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
