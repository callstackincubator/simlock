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
