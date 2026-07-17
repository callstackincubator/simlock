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
