# Known pitfalls

## A SIGKILLed lease holder keeps its device until the TTL expires

A lease ends in exactly one of two ways: somebody releases it, or its TTL
runs out ([ADR 0004](adr/0004-ttl-first-leases-on-every-transport.md)). A
running `simlock lease` — or an MCP session — releases on the way out, so a
normal exit, a `SIGINT`/`SIGTERM`, or the death of the holder's parent all
free the device at once, exactly as before. That is the holder's own policy,
though, and it needs the holder to run code.

**The pitfall:** a holder killed with `SIGKILL`, or lost with its machine,
runs nothing. Nothing else steps in for it — the daemon released leases on
socket close before ADR 0004 and no longer does, on any transport — so the
device stays `leased` until `ttlDeadline`, at most the lease's own TTL after
its last renew: `lease.defaultTtlMs` (15 minutes by default) unless the
request asked for more, never more than `lease.maxTtlMs`. `simlock status` shows
the lease and its "last renewed" time throughout; an operator who does not
want to wait can end it now with `simlock release <lease-id>`.

**Why it is accepted:** the alternative is a `releaseOnDisconnect` flag
honoured only by transports that have a connection, which puts
per-connection lease state back into the daemon and at every gateway hop, and
gives "when does this lease end" a second answer that HTTP can never provide.
ADR 0004 considered and rejected it; a short default TTL is the accepted
trade, and it buys the reverse case too — a machine sleep, a daemon upgrade,
or a socket hiccup no longer costs a live holder its device.

**The knob:** `lease.defaultTtlMs` bounds the leak globally, and `--ttl` (or
`ttlMs` on a request) bounds it for one lease. Both are worth lowering in a
CI-shaped fleet where holders are killed routinely; both cost more renew
traffic and a tighter deadline for a holder that stalls. See
[CONFIGURATION.md](CONFIGURATION.md).

## Orphaned lease holders (resolved)

`simlock lease` runs in the background, renews its lease on a timer, and
releases it when it exits.

**The pitfall:** if the agent crashed or was killed, its backgrounded `lease`
process did *not* die with it — it got reparented (to launchd on macOS) and
kept running, holding the lease indefinitely. This silently reintroduced the
"crashed agent holds a device forever" problem the tool exists to solve.

Under ADR 0004 it is the one failure the TTL cannot bound. Every other way of
losing a holder ends at the deadline, because nothing is renewing (see the
section above). A reparented holder is *alive*: its renew timer keeps firing
against a lease nobody wants any more, pushing the deadline out ahead of
itself forever. The TTL is a bound on silence, and this holder is not
silent.

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
touches only that one file.

This fix is about a holder outliving its owner, nothing more. A holder that
dies without running its release path is the section above, and the TTL is
what bounds that one.

## Crash recovery cannot restore in-device session state

`LeaseHealthMonitor` reboots a leased device whose process died outside
simlock and hands the same lease back to its holder, so the device and its
on-disk state — installed apps, written data — survive the crash intact.

**The pitfall:** anything the agent had running *inside* the device died with
the process and a reboot cannot bring it back: a launched app, a `log
stream`, an Appium/XCUITest session, a port forward. Simlock has no visibility
into what was running there, so it cannot even enumerate what was lost, let
alone restore it. This is why recovery notifies the holder
(`device-unhealthy` / `device-recovered` — pushed to a running `simlock
lease`'s stderr, and drained from the `notices` array on `POST
/v1/leases/{id}/renew` by a polling HTTP client, which has no connection to
push to) rather than healing silently — the agent has to notice and
re-establish its own session state.

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

## Device roots are an accident boundary, not a security boundary

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

**`device.exec` sits inside the same boundary, not outside it.** The check it
makes is that the caller owns the lease it names ([ADR
0005](adr/0005-gateway-and-worker-modes.md) §19a); what the *command* then
points at is the tool's business. So an agent token holding any one lease can
run `adb -s <someone-else's-serial> shell …` or `simctl --udid <someone
else's udid> …`, and the daemon will run it: the target device is in the same
root, reachable from the same scoped `simctl`/`adb`, and the arguments are
passed through unread. Ownership is proven for the *lease*, not re-derived
for every device id inside the argv.

That is deliberate. Refusing `-s` / `-t` / `--udid` outright would break the
ordinary case — a lease holder naming its own device explicitly, which every
`adb` invocation in a script does — and refusing only *other people's* ids
means parsing each tool's argument grammar well enough to decide which token
is a device id, on a surface that changes with the platform tools rather than
with simlock. A parser that is wrong in the permissive direction refuses
nothing extra; one that is wrong in the strict direction refuses commands
that were always fine. The verbs simlock *does* refuse
([CLI.md](CLI.md)) are the ones that move a device's lifecycle behind the
registry's back or escape containment altogether — `adb kill-server`,
`simctl delete` — which is a judgement about what an action does, not about
identity. adb's server-scope globals are handled differently, and more
strictly, because a caller-supplied one there does not merely name a device —
it can silently repoint the whole command at a server Simlock does not own
(safety rule 9): `simlock adb` allow-lists `-s` / `-t` / `-d` / `-e`, the
globals that select a device *within* the containment simlock already
established, and refuses everything else positioned before the subcommand —
`-P` / `-L` / `-H` / `--server-port` by name, and any other global (including
one this driver has never heard of) on the general principle that an argument
it cannot vouch for is refused rather than assumed harmless.

The consequence follows the same rule as the rest of this section: mutually
untrusted agents on one machine need OS-level isolation. Agents that trust
each other not to be malicious — the fleet this tool is for — get exactly
what the roots buy them, which is that nobody reaches another agent's device
*by accident*.

**Status:** accepted by design. Anything that needs a real trust boundary
(multi-tenant machines, untrusted agents) needs OS-level isolation, which is
out of scope for a device control plane.

## A root's ownership is proven at startup and trusted for the daemon's life

`ensureOwnedRoot` runs once per driver, at daemon start. Every later answer to
"is this device Simlock's?" — `listManaged`, every `simctl --set`, every
`ANDROID_AVD_HOME` — is computed against that path again and again, but the
*proof* behind it is the one taken at boot and never retaken.

**The pitfall:** a daemon can be up for days. In that time the path can become
a symlink, or an `mv` can leave the user's own device set standing exactly
where Simlock's root was. Nothing re-checks, so `listManaged` starts answering
with the user's simulators, every one of them has no registry record, and
`doctor` reports the lot as orphans. This is a different case from the accident
boundary above, which is about someone deliberately reaching *into* the root;
this one is the root being swapped *under* Simlock, and it turns a report into
a claim over devices that were never Simlock's.

**Fix, and the deliberate half-measure in it:** destroying re-proves the root
and reporting does not. `doctor --purge-orphans` calls `Driver.revalidateRoot()`
— the same validation `create` was judged by, with the same arguments —
immediately before its first destroy, and abandons the whole purge if any root
refuses. Nothing else does, and that asymmetry is the point: a stale proof
behind a *report* costs a confusing `doctor` run, while a stale proof behind a
`destroy` costs the user their devices. Re-validating on every reconcile tick,
or before every `listManaged`, would buy nothing for the case that matters and
would put a filesystem check on the reaper's path.

**Status:** accepted, and bounded by design — the purge is the only destructive
path root membership alone can authorise (safety rule 1), so it is the only one
that needs the re-proof. Restarting the daemon re-proves everything; a driver
whose root has gone bad then simply does not start.

## Simlock's adb server has to be supervised by pid

Android containment needs Simlock to run its own adb server, because `adb` has
no equivalent of `simctl --set`. That server is started with
`ADB_REJECT_KILL_SERVER=1` so an agent's reflexive `adb kill-server` cannot
detach every leased emulator at once.

**The pitfall:** that protection applies to Simlock too. `adb kill-server`
against its own server returns `error: kill-server rejected by remote server`,
for the life of the process. The only way to stop it is to kill the pid.

So the pid is recorded in `~/.simlock/adb-server.json` as soon as the server
has one — before it is known to be listening, since the gap between the two is
a window a daemon can die in and a listening server with no record is
unrecoverable. The daemon reaps it by pid on shutdown, and a daemon that
crashed must find that file on restart and adopt-or-kill the server it names. A
stale entry — the pid is gone, or belongs to something else now — must be
treated as no server, not as a server to kill blindly. "Belongs to something
else" is decided from the process's full command line (an `adb` binary, this
server's `-P <port>`, and `nodaemon`), never from the command name alone: a
recycled pid most often belongs to *some* adb, and the shared server every
other tool on the machine is talking to is precisely the wrong thing to
SIGKILL. Where the process table cannot be read at all, the record is kept —
deleting it would strand a live server behind an `occupied` refusal forever.

The file is deliberately *not* part of `state.json`: process supervision must
not depend on registry integrity, since a corrupt registry is exactly when you
would need to clean up a leftover server.

**Related:** unix-domain sockets are not available for the adb server on
macOS (`unix:`, `localfilesystem:`, and `localabstract:` are all rejected), so
this has to be a TCP port and cannot live as a socket file inside
`~/.simlock/` the way `daemon.sock` does. That is why
`drivers.android.adbServerPort` exists and why two Simlock instances on one
machine need distinct values for it.

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
way `provision`/`makeReady` do. A CLI or MCP caller waiting on a
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

## True cancellation during provisioning is not implemented (ADR 0003 §10)

`simlock/client`'s `requestLease` takes an `AbortSignal`. When device work is
already in flight (provisioning, booting, reclaiming) and the caller aborts,
the client sends `lease.cancel`, which answers `not-cancellable` at that
stage — the daemon keeps doing the work. What the client does instead:
it waits for the request's real outcome, and if a grant still lands, releases
it immediately so the caller never ends up holding a device it already
walked away from, then surfaces `CANCELLED` either way.

**The pitfall:** this is release-on-arrival, not interruption. The
provisioning/boot/reclaim work the abort was meant to stop keeps running to
completion (or failure) on its own, consuming the time and driver resources
it would have anyway, and the released device pays a purge (see "Release
hands the purge off" in [ARCHITECTURE.md](ARCHITECTURE.md)) before it's
usable by anyone else. A caller that aborts expecting the operation to
actually stop gets a device that is unavailable for roughly as long as an
uncancelled request would have taken, just without ending up holding it.

**Status:** known and accepted for this release, deliberately out of scope
per the ADR ("True cancellation during provisioning is deliberately out of
scope here"). Actually interrupting driver work mid-flight would mean
threading cancellation through `Driver.provision`/`makeReady`/`reclaim`
themselves — real protocol and driver-interface machinery across both
platforms, not a client-side change.

**Possible future fix:** none planned yet. A caller that needs to bound the
cost of an abandoned request should set `timeoutMs`/`--timeout` tightly
rather than relying on abort to cut a request short once device work has
started.

## The HTTP tracker and notice buffer are the last frontend-held state (#72)

ADR 0003 moved request handling into one shared, transport-independent
dispatcher (`src/daemon/dispatcher.ts`) that both the unix socket and HTTP
call — but two pieces of state still live in the HTTP frontend rather than
the daemon's core:

- **`LeaseRequestTracker`** (`src/http/tracker.ts`) — the in-memory registry
  behind `POST /v1/lease-requests` and the resource it returns
  (`GET`/`DELETE /v1/lease-requests/{id}`, its SSE stream, `Idempotency-Key`
  replay). This is what lets HTTP offer an async-resource-shaped API
  (`202`-then-poll) on top of the core's request/grant flow, which itself
  has no notion of a durable, independently-addressable "request resource."
- **`LeaseNoticeBuffer`** (`src/http/notices.ts`) — buffers owner-routed
  device-health facts (`device_unhealthy`, `device_recovered`) per lease so
  a polling-only HTTP client (no open connection to push to) can drain them
  on its next `renew` or SSE reconnect instead of missing them entirely.

**The pitfall:** both reset on a daemon restart (in-memory, no persistence),
and both are HTTP-specific reimplementations of "track something about a
request/lease across calls". The socket frontends need neither, but not because
a connection holds anything — under ADR 0004 it holds nothing. They need
neither because a socket client is *there* when the fact happens: the daemon
pushes a device-health fact to whatever connections own the lease at that
moment, and a request's progress rides the call that made it. A polling HTTP
client is absent between calls by construction, so something has to hold the
fact until it comes back, and today that something lives in the frontend. A
daemon restart loses in-flight lease-request tracking state and buffered
notices the same way it always did pre-ADR 0003 — see [Lifecycle
semantics](HTTP-API.md#lifecycle-semantics) for the documented recovery loop
(`404` → re-request → maybe `409` → `GET`), which exists specifically because
the tracker does not survive a restart.

**Status:** known, and explicitly called out as the ADR's own unfinished
seam, not an oversight: "the HTTP tracker and notice buffer remain the known
stateful leftovers in a frontend." The ADR's dispatcher work "prepares the
seam... but does not do that work" of removing them.

**Planned fix:** [#72](https://github.com/callstackincubator/simlock/issues/72),
re-scoped by this ADR to core durability and idempotency — moving durable,
idempotent lease requests into the core registry itself, so a lease request
becomes a first-class, restart-surviving core concept instead of a resource
HTTP alone tracks. Once that lands, `LeaseRequestTracker` and
`LeaseNoticeBuffer` should be able to shrink to thin views over core state
rather than independent bookkeeping.

## HTTP single-lease reads answer 404, not 403, for an unowned lease

`GET /v1/leases/:id` and `GET /v1/leases/:id/events` resolve their lease
through `findOwnedLease` (`src/http/app.ts`), which calls `lease.list` and
filters to the id in question. `lease.list`'s own scoping (own leases; admin
sees all) means an id owned by a different agent simply is not in the list —
indistinguishable, at that point, from an id that does not exist at all. Both
answer `UNKNOWN_LEASE`/404.

Over the socket there is no equivalent read: `lease.list` is the only
operation that can answer "what does this session see", and it does not
distinguish "unknown" from "not yours" either — it just omits the row. So
these two routes are not actually diverging from a socket answer; there is no
`lease.get` operation with an `ownsLease` authorize hook to diverge from.

This is deliberately narrower than the fix applied to the two *mutating*
single-lease routes, `POST /v1/leases/:id/renew` and `DELETE /v1/leases/:id`,
which used to go through the same `findOwnedLease` helper and therefore used
to answer 404 for an unowned lease where the socket's `lease.renew`/
`lease.release` (via their `ownsLease` authorize hook) answer `FORBIDDEN`/403.
Those two routes now dispatch directly and let the shared error table answer,
matching the socket exactly. The two read routes above were left on
`lease.list`-filtered 404 because there is no dispatcher operation for them to
match — 404-as-anti-enumeration is the *table's* answer here too, just via
`lease.list`'s own filter rather than a per-op `authorize` hook.

**If a `lease.get` operation with an `ownsLease` hook is ever added to the
contract**, these two routes should move onto it and start answering 403 for
an unowned lease, the same way the mutating routes do today.

## HTTP error codes outside the closed contract union

ADR §7: `SimlockError` has a `code` from the contract's closed union, and "a code the client
does not know... wraps as `UNKNOWN_DAEMON_ERROR`". Four codes the HTTP gateway answers with
today (`src/http/errors.ts`) have no row in that union
(`src/contract/errors.ts`'s `ERROR_TABLE`), so a typed client built against the contract can
only ever see them as `UNKNOWN_DAEMON_ERROR` with the real code buried in `details`:

| Code | Status | Meaning | Where thrown |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/invalid bearer token | `errors.ts:37` |
| `UNKNOWN_LEASE_REQUEST` | 404 | No such lease-*request* resource (`POST /v1/lease-requests`'s HTTP-only envelope, ADR §11, kept until #72) | `errors.ts:59` |
| `REQUEST_NOT_CANCELLABLE` | 409 | `DELETE /v1/lease-requests/:id` on a request already granted or past cancellable state | `errors.ts:70` |
| `REQUEST_CANCELLED` | 500 | Defensive-only: `RequestCancelledError` reaching `mapError` should never happen in practice (the tracker consumes it internally) | `errors.ts:123` |

`UNKNOWN_LEASE_REQUEST` used to be minted as `UNKNOWN_REQUEST` — the same code the contract
already declares, but for a different meaning at a different status: the contract's
`UNKNOWN_REQUEST` is a *protocol* error ("unknown operation name") at 400, thrown by
`DispatchError` in `src/daemon/dispatcher.ts` for a request naming an operation the dispatcher
has no handler for. Reusing it for "no such lease-request id" at 404 meant a client branching
on `error.code` alone could not distinguish the two (S8, adversarial review). Renamed to
`UNKNOWN_LEASE_REQUEST` so it no longer collides, but that only fixes the collision — it does
not add a contract row, so it still wraps as `UNKNOWN_DAEMON_ERROR` for a typed client.

**What the contract needs** (out of scope here — `src/contract/` is owned elsewhere): four new
rows in `ERROR_TABLE` (`src/contract/errors.ts`), each with a `kind` and the `httpStatus`/
`cliExitCode` columns this table already has for every other code:

```ts
UNAUTHENTICATED: Record<string, never>;             // kind: "protocol", httpStatus: 401
UNKNOWN_LEASE_REQUEST: Record<string, never>;        // kind: "domain",   httpStatus: 404
REQUEST_NOT_CANCELLABLE: { readonly leaseId?: string }; // kind: "domain", httpStatus: 409
REQUEST_CANCELLED: Record<string, never>;            // kind: "domain",   httpStatus: 500
```

Once those exist, `src/http/errors.ts` should stop constructing ad hoc `HttpApiError`s for
these four and instead go through the same `ERROR_TABLE`-driven path `mapError` already uses
for every contract-declared code, the same way `UNKNOWN_LEASE`/`FORBIDDEN`/`BAD_REQUEST` do
today.

## A `device.exec` command is authorized once, at its start

`device.exec` ([ADR 0005](adr/0005-gateway-and-worker-modes.md) §19a) checks
that the caller owns the lease it names, then spawns the command and streams
its output. The check happens once. A command that is still running when its
lease ends -- expired on its TTL, released by its holder, force-released by an
operator -- keeps running, and the device it is pointed at may by then have
been reclaimed and granted to somebody else.

**The pitfall:** it is tempting to read the ownership check as covering the
command's whole lifetime. It covers its *start*. Nothing kills a running child
when a lease ends, and nothing re-checks the lease while it runs.

Three things bound the exposure, none of which closes it:

- `exec.timeoutMs` (ten minutes by default) is a hard ceiling on how long any
  one command can outlive anything.
- Reclaim is not instant, and a device goes through `reclaiming` before it can
  be granted again -- so the window is a straggler's, not a routine one.
- The refusal list still applies: a command that outlives its lease cannot be
  one that changes a device's lifecycle behind the registry's back.

**Status:** accepted for now. Killing the child on `lease.expired` /
`lease.released` is the obvious fix and is cheap to add, but it makes the
worse trade in the common case: the reason a disconnect does not kill a
running command is that a half-applied `simctl install` interrupted by a
tunnel blip is worse than one that finishes with nobody watching, and a lease
that expires *while its holder is mid-install* is the same situation with the
same answer. Revisit it with the gateway work (#115), where a proxied exec
adds a second place a lease can end without the worker noticing at once.

## `device.exec` carries no files (ADR 0005)

A remote agent drives its leased device with `device.exec` — `simlock simctl`
/ `simlock adb` against a gateway, or `POST /v1/leases/{id}/exec` over HTTP.
The command runs on the machine that owns the device, which is what makes it
work at all across a fleet.

**The pitfall:** the *arguments* travel, the *files* do not. `simctl install
/tmp/MyApp.app` and `adb install ./app-debug.apk` resolve their path on the
worker's filesystem, so a build sitting on the agent's own machine is simply
not there — the command fails with the tool's own "no such file" rather than
with anything simlock says, which reads like a broken lease until you notice
which machine ran it. The same applies in reverse for output: `simctl io
booted screenshot shot.png` writes `shot.png` on the worker.

**Why it is accepted:** a file transfer is a second, byte-heavy concern with
its own questions (size caps, resumability, where the bytes land, who deletes
them), and answering them badly inside the lease path is worse than not
answering them. v1's honest position is that artifacts arrive out of band — a
shared volume, a checkout the CI job already did on that machine, an
`scp` the operator's own tooling does.

**Status:** accepted for v1 and designed around rather than designed out.
[ADR 0005](adr/0005-gateway-and-worker-modes.md) leaves the seam open
deliberately: `device.upload` would stream chunks as request-scoped pushes
over the same wire, into a per-lease scratch directory deleted on release.
Nothing about `device.exec`'s shape has to change to add it.

**Possible future fix:** `device.upload`, a post-v1 idea rather than planned
work — it belongs with the byte-heavy concerns
[ADR 0005](adr/0005-gateway-and-worker-modes.md) lists as non-goals.

## `device.exec` has no pseudo-terminal, so interactive commands break

Locally — `simlock simctl` / `simlock adb` against a worker over its unix
socket — the CLI spawns the tool with inherited stdio, so an interactive `adb
shell` is a real interactive shell and always has been.

**The pitfall:** through a gateway, or over HTTP, the same command goes
through `device.exec` instead, and there is no PTY on the far end. `stdin` is
one string sent with the request and then closed. Line-oriented commands are
fine (`adb shell getprop`, `adb shell input tap 100 200`, `simctl install`);
anything that wants a terminal is not — a full-screen program renders as
escape sequences, and a tool that stops to ask a question waits for input
that can never come until the timeout kills it. The failure is quiet in the
worst case: the command hangs until `exec.timeoutMs` (ten minutes) and then
fails `EXEC_TIMEOUT`.

The one shape of this that is *not* quiet is the most likely one. A bare `adb
shell` with no command — the thing a human types first — is refused up front
by the worker with `PASSTHROUGH_REFUSED` (CLI exit 2, HTTP `422`) and a
message saying it needs a terminal. It is the only refusal `device.exec` adds
to the passthrough list, and it exists precisely because the honest failure
for that command is immediate and legible, while the natural one is a
ten-minute stall ending in a timeout that says nothing about terminals. It
does not generalize: simlock cannot tell in advance which *other* commands
will block for input, so everything past this one case is still bounded by
the timeout rather than by a refusal.

**Why it is accepted:** a PTY is not a bigger version of a pipe. It needs
terminal allocation on the worker, window-size propagation, signal
forwarding, and a bidirectional stream where v1 has request-scoped pushes —
and it exists to serve a human at a keyboard, which is not who this control
plane is for. Agents send commands and read output.

**Status:** accepted by design, and the boundary is drawn where the docs say
it is: same command, same refusals, same exit code, no terminal. The local
path keeps its inherited stdio, so nobody loses an interactive shell they had
before.

**Possible future fix:** an interactive TTY is part of the reserved
`dataPlane` ([ADR 0005](adr/0005-gateway-and-worker-modes.md) lists it among
the non-goals), not a follow-up to `device.exec`.

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
every lease response carries a feature-profile signal so a caller can tell a
feature-loss failure apart from an actual bug instead of guessing —
`device.featureProfile === "reduced"` on the CLI/MCP/client contract shape
(`slim` as a top-level boolean grant field is gone as of 0.3.0, ADR 0003
§11), or HTTP's own `lease.slim` boolean, which is still derived from the
same underlying signal.

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

## `simlock simctl` / `simlock adb` can hang forever reading a piped stdin

ADR 0005 §19c: a piped stdin is read to EOF first, then sent as `device.exec`'s
one-shot string (§19a) — there is no incremental stdin channel, so the whole
thing has to exist before the request can be sent at all. `readPipedStdin` in
`src/cli/index.ts` does exactly that: `process.stdin.isTTY === true` means
nothing was piped and it returns `undefined` immediately, and otherwise it
reads the stream to completion with no bound.

**The pitfall:** "not a TTY" and "has a well-behaved sender" are different
facts. `simlock adb shell getprop` run from a CI job whose stdin is an
inherited pipe that nothing ever closes (a common shape for a step that
redirects a long-lived process's output, or simply forgets to redirect stdin
from `/dev/null`) blocks on this read before the command is even sent — not
inside the command, not bounded by `exec.timeoutMs`, which only starts once
`device.exec`'s request goes out. There is no timeout here at all, and no way
to tell from the caller's side, short of the process just never finishing,
that this is what happened.

**Why this is not being fixed by adding a bound:** §19c is explicit that the
whole piped input is read before the request is sent, because `device.exec`'s
`stdin` is a single string handed over once, not a channel — there is nowhere
to send a partial read to. A read that gave up after some fixed time would
either send a truncated `stdin` (silently changing the command's input, which
is worse than hanging) or refuse the command outright on a caller whose input
was simply slow rather than infinite, and simlock has no way to distinguish
the two from here. Every other tool with the same read-to-EOF contract for a
piped stdin (`cat`, `jq`, `xargs` without `-n`) has the identical hazard for
the identical reason; it is not a defect specific to this CLI, and a caller
that pipes in CI is already expected to close or redirect stdin the way any
other pipe-reading command line requires.

**Status:** accepted, deliberately not worked around. If this bites in
practice the fix belongs at the call site — redirect stdin from `/dev/null`
in the job that does not mean to pipe anything (`simlock adb shell getprop
</dev/null`), or pass `stdin` some other way once a future need justifies
one — not in `readPipedStdin` guessing at a timeout ADR 0005 does not ask
for.
