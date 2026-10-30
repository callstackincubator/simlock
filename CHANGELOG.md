# Changelog

## Unreleased

ADR 0004 (`docs/adr/0004-ttl-first-leases-on-every-transport.md`): there is
now one kind of lease, on every transport. A lease carries a TTL, and the
only thing that keeps it alive is a client-initiated `lease.renew` arriving
before the deadline — on the unix socket, over HTTP, over MCP, and through a
gateway alike. Held mode is gone as a daemon concept; staying alive to renew
and releasing on exit is now the CLI's and the MCP session's own policy over
an ordinary lease. This is a breaking release for the contract, three config
keys, and one user-visible behaviour; see below.

ADR 0004 is **Accepted — not yet implemented**: the entries in this section
describe the decided end state, and they land with the PRs that implement it
(the client's renew timers, and the daemon's heartbeat removal, config
rename, and protocol bump).

ADR 0005 (`docs/adr/0005-gateway-and-worker-modes.md`): a simlock daemon now
runs in one of two modes. A **worker** is what every daemon is today — it
owns the devices on one machine — and a **gateway** owns none, fronting the
workers that dial out to it over a single WebSocket **uplink**. A gateway
keeps one fleet-wide queue, dispatches each request to the worker best placed
to serve it, proxies device commands to the worker that owns the device, and
implements the same typed contract towards its own clients, so every existing
frontend works against it unchanged. Nothing here is removed or repurposed
and a daemon left in the default `mode: "worker"` behaves exactly as it does
today, so every one of the entries below is additive **except the protocol
bump** — `device.exec` and its `output` pushes take the socket wire to
protocol 5, which means a client and a daemon still have to be upgraded
together. That one is listed under BREAKING CHANGES above, with ADR 0004's
own bump, since it is the same wire and the same upgrade.

ADR 0005 is **Accepted — not yet implemented** as well: the entries under
"ADR 0005" below describe the decided end state, and they land with the PRs
that implement it (`device.exec` on the worker, then the gateway skeleton and
worker views, the fleet queue and forwarding, drain and reconnect). The
documentation is the exception to that order: it lands first, as the
specification those changes are written against.

### ⚠ BREAKING CHANGES

- **The daemon protocol is now 6**, `{min: 6, max: 6}`, with no compatibility
  shim. ADR 0008 makes the catalog's `modelRuntimes` and `modelAliases`
  required, so a gateway
  marks a worker on 5 `incompatible` with both ranges shown and sends it
  nothing; upgrade the worker. A client built against 5 gets
  `PROTOCOL_VERSION_UNSUPPORTED` from `hello`, as with every earlier bump.
- **The daemon protocol is now 5**, `{min: 5, max: 5}`, with no compatibility
  shim — the same no-shim rule that took it to 4. ADR 0005 adds `device.exec`
  and its `output` push family, and moves `status.get`'s `health` into a
  `daemon` block that also carries `mode`, so
  advertising 4 would claim a compatibility path that does not exist. A client
  built against 4 does not overlap this daemon and its `hello` fails with
  `PROTOCOL_VERSION_UNSUPPORTED` naming both ranges; `daemon.stop` stays the
  frozen exception, so `simlock daemon stop` then starting the new daemon is
  the upgrade path.
- **Contract:** `lease.heartbeat` is removed as an operation, and `heartbeat`
  is removed as a `hello` capability. The daemon never pushes to a client to
  prove liveness any more; nothing replaces it, because `lease.renew` already
  did the job on every transport that has one.
- **`mode` leaves the contract.** `lease.request` no longer accepts it, and the
  lease record no longer carries it. `ttlMs` is now accepted on **every**
  `lease.request` — supplying it used to be `BAD_REQUEST` for a held lease —
  and is capped at `lease.maxTtlMs`, above which a request or a renew is
  `BAD_REQUEST` rather than silently clamped. A caller reading `lease.mode` off
  a grant now reads `undefined`, which is falsy, not an error; there is nothing
  to branch on any more.
- **A body-less renew re-applies the lease's own TTL, not
  `lease.defaultTtlMs`.** The lease record stores the `ttlMs` it was granted
  with (or last renewed with, when a renew carried one), and `lease.renew`
  without a `ttlMs` resets the deadline to now + that width.
  `lease.defaultTtlMs` now applies in exactly one place: a `lease.request` that
  names no `ttlMs`. A caller that relied on renew snapping every lease back to
  the 15-minute default will find a four-hour lease staying four hours wide.
- **`lastRenewedAt` replaces `lastHeartbeatAt` — as a new stored field, not a
  rename.** `lastHeartbeatAt` was never persisted: the dispatcher derived it as
  `ttlDeadline - heldTtlBackstopMs`, which only worked because every held lease
  shared one backstop width. With per-lease TTLs that arithmetic has no answer,
  so the daemon now writes `lastRenewedAt` onto the lease record at grant and
  on every renew, and `simlock status` renders it as "last renewed". A consumer
  reading `lastHeartbeatAt` gets `undefined`.
- **Socket protocol:** moves twice in this release, once per ADR, each time
  with no compatibility shim. ADR 0004 removes `lease.heartbeat` and `mode`,
  taking the wire to protocol 4; ADR 0005 adds `device.exec`, its `output`
  push family, and the `mode` field on `status.get`'s daemon block, taking it
  to 5. **What ships advertises `{min: 5, max: 5}`** —
  4 is a step along the way, not a range anything releases with, since a
  range widens only where a compatibility path is kept (ADR 0003 §6). A
  version-mismatched client fails `hello` with `PROTOCOL_VERSION_UNSUPPORTED`
  and never restarts the daemon — run `simlock daemon stop` once it's idle.
  `daemon.stop` remains a frozen exception, accepted at any protocol version
  the daemon has ever spoken.
- **Config:** three `lease.*` keys are retired — `lease.detachedTtlMs`,
  `lease.heldTtlBackstopMs`, and `lease.heartbeatIntervalMs`. All three are now
  simply unrecognized: `simlock config` warns about each and ignores it,
  exactly as it does for any other unknown key. **None of them is aliased onto
  a new key**, so a config still setting `lease.detachedTtlMs` gets
  `lease.defaultTtlMs`'s default rather than the value it wrote — copy the
  value across. New: `lease.defaultTtlMs` (15 minutes, applied to a request
  that names no `ttlMs`) and `lease.maxTtlMs` (4 hours). Both must be positive
  numbers with `lease.defaultTtlMs <= lease.maxTtlMs`; a config that breaks
  either rule is **rejected at load and the daemon does not start**, naming the
  offending key, rather than being clamped. Note the two treatments are
  different on purpose: a retired key is warned about and ignored, because it
  is a leftover; a TTL pair that contradicts itself has no safe fallback to be
  ignored in favour of. See `docs/CONFIGURATION.md#retired-lease-keys`.
- **Upgrading over a live held lease:** a lease a pre-ADR-0004 daemon
  persisted in held mode survives the upgrade with its persisted deadline
  intact — up to the old one-hour `lease.heldTtlBackstopMs`. Nothing can
  renew it: its holder speaks protocol 3 and the new daemon speaks
  `{min: 5, max: 5}`, so its `hello` fails. The lease simply expires on that
  deadline and its device is reclaimed, or `simlock release <lease-id>` ends
  it sooner. Stopping the old daemon while it is idle, as the protocol-
  mismatch error already advises, avoids the situation entirely.
- **A holder killed with `SIGKILL` keeps its device until the TTL expires.**
  The daemon keeps no per-connection lease state and releases nothing when a
  connection closes, on any transport — so a holder that dies without running
  its own release path (`SIGKILL`, a crash, a lost machine) holds its device
  until `expiresAt`, at most the lease's own TTL after its last renew —
  `lease.defaultTtlMs` unless the request asked for more, never more than
  `lease.maxTtlMs` — against today's immediate release on socket close. A
  holder that exits normally, is `SIGTERM`ed, or whose parent dies still
  releases at once, because that is its own policy. This is the one behaviour
  change a local user notices, and it is the accepted price of a single
  mechanism; the reverse case improves, as a machine sleep or a socket hiccup
  no longer costs a live holder its device. `lease.defaultTtlMs` and `--ttl`
  bound it — see `docs/known-pitfalls.md`.
- **`simlock daemon stop` no longer releases leases**, and there is no
  orphaned-lease sweep at daemon startup. Leases persist across a restart and
  the next daemon restores each one's TTL timer from its deadline; one whose
  deadline passed in between expires as soon as a daemon is there to expire it.
- **Events:** `lease.granted`'s payload drops `mode`. `lease.released` loses
  the `closed` and `orphaned` reasons — a closing connection is not a release
  and never was a fact worth emitting, and there is no startup sweep to produce
  an orphan. `explicit`, `killed`, and `device-lost` remain.
- **`simlock/client`:** `onLeaseLost` no longer fires with reason
  `daemon-connection-lost` when a connection dies. The lease is still granted
  and still yours — reconnect and renew it, or let its TTL run out.
  `onConnectionLost` is what reports the dead connection; `onLeaseLost` now
  only ever reports a lease the daemon actually ended.
- **The MCP server's renew timer reconnects, but never launches a daemon.** ADR
  0003 §10/§11 gave MCP one lazy reconnect trigger, the next tool call; ADR
  0004 adds a second. When the renew timer fires against a dead client the
  session reconnects and renews, so an idle session no longer loses its lease
  waiting for a call that may not come. That trigger only ever connects to a
  daemon that is already listening — auto-launch stays a tool-call concern, so
  an operator's `simlock daemon stop` is not undone by an idle session, and a
  lease held across a stopped daemon expires unless the daemon is back before
  its deadline.
- **A running `simlock lease` exits `1` when its daemon connection dies**,
  writing one `DAEMON_CONNECTION_LOST` line that names the lease id and its
  `ttlDeadline`. The CLI still does not reconnect (ADR 0003 §10), so it can
  neither renew nor release — but it no longer implies the lease went with it.
  The lease stands until its deadline and any later invocation can
  `simlock lease renew <lease-id>` it. Exit `14` keeps its narrower meaning:
  the daemon ended the lease while the connection was alive.
- **`doctor` reports an unavailable optional module as `module-unavailable`.**
  The finding carries a `module` field (`agent-device` today) and replaces
  `agent-device-unavailable`; the stderr line is `<module>  fail  <message>;
<remedy>`. The daemon protocol is now 37.

### Features

These ship with the PRs that implement ADR 0004; this section describes what
those changes add, alongside the breaking changes above.

- **cli:** `simlock lease` (without `--detach`) renews its own lease at one
  third of the lease's TTL for as long as it runs — sending no TTL of its
  own, so the deadline keeps the width the lease was granted with — and
  releases on exit, parent death, or `SIGINT`/`SIGTERM`. `--detach` prints
  the grant and exits; the lease it leaves behind is the same kind of lease,
  and renewing it is the caller's job.
- **cli:** `simlock lease --ttl <duration>` sets a lease's initial TTL in
  place of `lease.defaultTtlMs`, capped by `lease.maxTtlMs`.
- **daemon:** one expiry path for every frontend — startup restores every
  lease's TTL timer from its persisted deadline, and the held-lease
  bookkeeping kept for release-on-close is deleted along with the
  `StartupConverger` orphan sweep that existed to clean up after it.
- **config:** `lease.maxTtlMs` bounds what any caller may ask for, so one
  client cannot pin a device for a day by naming a large `ttlMs`.
- **contract, daemon, http, cli:** `device.exec` runs `simctl`/`adb` **on the
  machine that owns the device** and streams the output back, so an agent that
  is not on that machine can drive the device it leased
  ([ADR 0005](docs/adr/0005-gateway-and-worker-modes.md) §19a-§19e). The daemon
  resolves the command through the same driver passthrough `simlock simctl` /
  `simlock adb` already use — the same root scoping, the same refusal list —
  and pushes each chunk as it arrives (a new request-scoped `output` push
  family) rather than buffering any of it; the call resolves with the
  command's exit code. Over HTTP it is `POST /v1/leases/{id}/exec`, answering
  Server-Sent Events: an `output` event per chunk, then a terminal `exit` or
  `error`. `simlock/client` gains `exec(input, { onOutput })`.
  `simlock simctl` / `simlock adb` are unchanged against a `worker` — they
  still spawn with inherited stdio, so an interactive `adb shell` keeps its
  terminal — and take this path against a `gateway`, which owns no devices;
  the CLI reads which it is talking to from `mode` in `status.get`'s daemon
  block rather than guessing from its transport, and both commands now accept
  `--lease <id>` (ignored against a worker, so one command line works against
  either). `stdin` is a one-shot string, read from a pipe to EOF before the
  command starts: there is no pseudo-terminal, so line-oriented commands work,
  full-screen ones do not, and a bare `adb shell` is refused
  (`PASSTHROUGH_REFUSED`) rather than left to hang. On this one operation
  **`admin` does not bypass ownership**: an admin session names the
  `requesterId` it is running the command for and the daemon compares it to
  the lease's own, which is what keeps a proxy holding one admin credential
  from reaching every lease on the machine.
- **contract:** `status.get` gains a `daemon` block, `{ health, mode }`.
  `health` moves into it from the top level, and `mode` (`worker`/`gateway`,
  read straight from the new `mode` config key) joins it — the one field that
  tells a client which kind of daemon answered, and what `simlock simctl` /
  `simlock adb` branch on. `simlock status` renders it as
  `Daemon: running (worker)`.
- **android:** `simlock adb` now refuses a caller-supplied `-P`, `-H`, `-L`,
  or `--server-port` anywhere in adb's globals — the arguments before the
  subcommand — including the attached forms `-P5037`/`-Hhost` and one that
  follows another global's value (`-s emulator-5554 -P 5037 shell …`), the way
  `simlock simctl` already refuses `--set`/`--profiles`. `adb` takes the
  _last_ `-P` on the line, so one supplied by a caller silently won over the
  one Simlock inserts and pointed the command at another server — including
  the machine's default one, outside Simlock's containment entirely. Past the
  subcommand those spellings are operands and still pass through
  (`simlock adb shell echo -Please`), and `-s`/`-t`/`-d`/`-e` are not refused
  at all: they select a device inside the containment rather than leaving it.
- **config:** `exec.timeoutMs` (default ten minutes) bounds one `device.exec`
  command; past it the process is killed and the call fails with the new
  `EXEC_TIMEOUT` error code (CLI exit `10`, the code the other "ran out of
  time" outcome already uses, and HTTP `504`) rather than reporting the exit
  code the kill produced.
- **catalog:** each platform in `simlock catalog`, `GET /v1/catalog`, the MCP
  `list_devices` tool, and `getCatalog` carries `modelRuntimes`: for every
  model, the installed runtimes it pairs with. A listed pair can be leased; on
  iOS a model and a runtime that are each installed can still fail to pair,
  and are not listed together. An iOS lease for an exact version now succeeds
  when any installed build of that version pairs with the model, not only the
  first one. `simlock catalog` prints each model with its runtimes. On a
  gateway, `simlock worker list` shows each worker's own pairings and the
  catalog pairs a model with a runtime when at least one worker does.
- **catalog:** each platform also carries `modelAliases`, the other names a
  lease accepts for a model in any letter case — on Android a built-in
  profile's AVD id, such as `pixel_8` for `Pixel 8` — and Android carries
  `images`, every installed system image with its API level, tag, and ABI,
  a foreign-ABI image included. `simlock catalog` prints both. On a gateway
  each worker's view carries its own and the catalog lists their union; the
  gateway does not yet route a request by another name.
- **events:** every business event is also written to `~/.simlock/events.jsonl`,
  one JSON line each, so the history survives a daemon restart or crash.
  `simlock events --since` and `GET /v1/events?since=` read it, reaching past
  a restart and past the 1000 events kept in memory; with no daemon running,
  `simlock events --since` (without `--follow`) reads the file and starts
  none. `--since` with
  `--follow` prints that history, then streams, with nothing lost or repeated
  where they meet. The file is capped by the new `eventLog.rotateBytes`
  (default 5 MiB, one rotated generation). `daemon.log` no longer gets its own
  copies of `component.installed` and `device.slimmed`; read them from the
  event file.
- **daemon:** `daemon.log` records every request that changes state, on every
  frontend, with who asked, how long it took and its error code; every
  background failure Simlock handled by retrying or destroying a device, with
  the device and the error; and at `log.level: debug`, read requests and every
  device command with its exit code. A failing event subscriber is logged as a
  JSON line. `simlock daemon logs --follow` prints new lines as they are
  written, across rotations.

### ADR 0005: gateway and worker modes

These ship with the PRs that implement ADR 0005, and every one of them is
additive: `mode` defaults to `worker`, so a daemon that ignores all of this
is the daemon that exists today.

- **contract:** `device.exec` (role `agent`) runs one `simctl`/`adb` command
  against a leased device on the machine that owns it —
  `{ leaseId, tool, args, stdin?, requesterId? }` in, `{ exitCode }` out,
  with output streamed as request-scoped `output` pushes
  (`stream: "stdout" | "stderr"` plus a chunk, keyed by frame id like
  `progress`). It works on the unix socket, over HTTP, and over the uplink,
  so a remote HTTP agent can drive its device against a lone worker with no
  gateway involved at all. `stdin` is one string sent with the request and
  then closed; there is no pseudo-terminal, and a bare `adb shell` with no
  command is refused (`PASSTHROUGH_REFUSED`) rather than left to stall until
  the timeout. A non-admin caller is gated the ordinary way, its principal
  against the lease's `ownerId`; `requesterId` exists for the one session
  that would otherwise bypass that check, the gateway's admin session on a
  worker, and **`admin` does not bypass on this one operation** — the worker
  compares the supplied `requesterId` to the lease's own.
- **contract:** `worker.list|drain|undrain|remove` (admin) manage the workers
  connected to a gateway; `mode` joins `status.get`'s daemon block; `workers`
  joins its output; `workerId` joins every device and lease in a gateway's
  aggregate; `worker: { id, label }` joins the lease object; and `worker`
  joins the token roles. All additive.
- **daemon:** `config.mode` selects `worker` (default) or `gateway`. A
  gateway starts no drivers, validates no device roots, and runs no reaper,
  health monitor, or capacity strategy; `src/gateway/` implements the
  contract's handlers over worker views and uplinks, importing nothing from
  `drivers` and, from `core`, only the platform-agnostic queue and bus. A
  gateway's one piece of persisted state is its **worker registry** — which
  workers it knows and which an operator has drained — kept under its
  `SIMLOCK_HOME` with owner-only permissions, so a drain survives both a
  worker reconnect and a gateway restart. Worker _views_ are rebuilt on every
  connect and never persisted.
- **Socket protocol:** the wire's second move this release, to protocol 5,
  with no compatibility shim — see BREAKING CHANGES above, where it is
  listed with ADR 0004's. `device.exec` and its `output` push family are new
  frames and no compatibility path is kept for them, so under ADR 0003 §6's
  honesty rule the range does not widen. Over the uplink this is ordinary
  version negotiation: a worker older than ADR 0005 does not overlap a
  gateway's range, is marked `incompatible` with both ranges shown, is never
  dispatched to, and keeps serving its own local clients until it is
  upgraded.
- **daemon:** one fleet queue on the gateway, dispatched to workers with
  `noWait: true`, so a gateway request never sits in a worker's queue and can
  be granted by whichever worker frees first. A request becomes `dispatched`
  on a grant or on the first `progress` push from that worker; only an
  immediate `NO_CAPACITY` (a stale view) leaves it queued. Routing is a pure
  function over the worker views behind `gateway.routing`; the v1 policy is a
  warm hit first, then the most free running capacity for the platform. Each
  view carries the worker's effective `downloads.policy`, read once with
  `config.get` on connect, so routing can tell whether a machine may install
  a missing runtime at all — the worker still clamps `allowDownload` through
  that same policy, as always.
- **daemon:** `lease.renew`/`release`/reads forward to the owning worker
  (the lease id names it), the one-lease-per-requester rule becomes
  fleet-wide, and the requester a gateway forwards is namespaced
  `gw:<gateway instance id>:<requester>` so local and fleet agents cannot
  collide on a worker. `lease.release-all` on a gateway releases only the
  leases that gateway issued, across every connected worker, and never a
  worker's own local leases; a worker it cannot reach is reported as
  `WORKER_UNREACHABLE` naming that worker while the rest still complete.
- **config:** new keys. Worker side: `gateway.url`, `gateway.token` (a join
  token), `gateway.label`, and `exec.timeoutMs` (10 minutes, and the
  authoritative one — that side owns the process). Gateway side:
  `gateway.routing` (`warm-then-free`), `gateway.disconnectedRetentionMs`
  (24 hours) and `gateway.execTimeoutMs` (11 minutes, a backstop for a worker
  that never answers, deliberately longer than the worker's own). Plus `mode`
  itself.
  Worker-only keys in a gateway's config are ignored with a warning, as
  unknown keys already are. Two pairs are rejected at load instead, and the
  daemon does not start: `mode: "gateway"` with `http.enabled: false`, since
  a gateway with no listener cannot be reached by anyone; and, in
  `mode: "worker"`, `gateway.url` without `gateway.token` or the reverse,
  since a half-configured uplink would otherwise come up looking like an
  ordinary standalone worker.
- **http:** new routes. `GET /v1/uplink` (WebSocket upgrade, join-token
  bearer, role `worker`) is the one inbound connection in a fleet;
  `POST /v1/leases/{id}/exec` streams a command's output as Server-Sent
  Events, the same shape `/events` already uses; `GET /v1/workers`,
  `POST /v1/workers/{id}/drain`, `DELETE /v1/workers/{id}/drain`, and
  `DELETE /v1/workers/{id}` (all `operator`) are what the console (#88)
  renders. "Multi-host brokering" leaves `docs/HTTP-API.md`'s "Not
  implemented" list, since this is it.
- **events:** `worker.connected`, `worker.disconnected`, `worker.rejected`,
  `worker.removed`, `worker.drain-started`, `worker.drain-ended`, and
  `request.dispatched` are emitted by a gateway, and every worker's own
  business events are republished on the gateway's bus with `workerId` added
  to the payload — an additive change, so no exception to events rule 6 is
  needed this time. `worker.rejected` reports an uplink refused at the door,
  which nothing else records — it is what answers "why did that machine never
  appear". See `docs/EVENTS.md`.
- **contract:** five new error codes. `WORKER_UNREACHABLE` (`kind:
"transport"`, CLI exit 1, HTTP 503 — where every other `transport`-kind
  code already sits) when a worker's uplink is down; `WORKER_CONNECTED`
  (exit 2, HTTP 409) refusing `worker remove` on a connected worker;
  `UNKNOWN_WORKER` (exit 12, HTTP 404) for `worker drain`/`undrain` naming a
  worker the gateway does not know — `remove` instead answers
  `{"removed": false}`, since forgetting an already-forgotten worker is not a
  failure; `UNSUPPORTED_IN_GATEWAY_MODE` (exit 2, HTTP 501, permanently
  rather than pending some later fan-out) for
  `nuke`/`cleanup`/`doctor`/`driver.passthrough` asked of a gateway; and
  `EXEC_TIMEOUT` (exit 10, HTTP 504) when a command outlives
  `exec.timeoutMs`. `device.exec`'s refusals are **not** new codes: a refused
  verb is the existing `PASSTHROUGH_REFUSED` and an unwrapped tool the
  existing `UNKNOWN_PASSTHROUGH_TOOL`, both already exit 2 / HTTP 422.
- **deps:** `ws` is added as a runtime dependency — Node ships a WebSocket
  _client_ but no server, and the uplink needs both ends. It sits behind the
  `UplinkListenerFactory`/`UplinkConnector` ports as their one real adapter,
  so nothing above the port imports it and tests script a fleet in memory
  without it.

### Documentation

- record ADR 0004 as **Accepted — not yet implemented**
  (`docs/adr/0004-ttl-first-leases-on-every-transport.md` and
  `docs/adr/README.md`): the documentation describes the decided end state;
  the code catches up in the changes that implement ADR 0004.
- rewrite the lease model across `docs/CLI.md`, `docs/CLIENT.md`,
  `docs/HTTP-API.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md`
  ("Leases", the frontend topology, and startup convergence),
  `docs/EVENTS.md`, `docs/ABOUT.md`, and `README.md`; record the SIGKILLed
  holder and re-frame the reparented-holder fix around renew timers in
  `docs/known-pitfalls.md`.
- record ADR 0005 as **Accepted — not yet implemented**
  (`docs/adr/0005-gateway-and-worker-modes.md` and `docs/adr/README.md`).
- describe gateways and workers across the user manual: a "Gateway and worker
  modes" section in `docs/ARCHITECTURE.md` (topology, uplink, worker views,
  the fleet queue, routing, lease forwarding, `device.exec`, failure
  behaviour, the safety argument, and `src/gateway/`'s boundaries), "Against
  a gateway" and `simlock worker` in `docs/CLI.md`, the uplink/worker/exec
  routes in `docs/HTTP-API.md`, `exec` and `mode` in `docs/CLIENT.md`,
  the new keys and a "Modes" section in `docs/CONFIGURATION.md`, the fleet
  events in `docs/EVENTS.md`, and a paragraph each in `docs/ABOUT.md` and
  `README.md`.
- `docs/IDEAS.md` drops "Cross-machine coordination" — ADR 0005 designs it —
  and gains the items that record deferred: gateway-side file upload for
  `device.exec`, reserved capacity slices, fan-out `doctor`/`cleanup`, richer
  routing (label selectors, requester affinity), and a byte-heavy data plane.
- `docs/known-pitfalls.md` records five accepted fleet gaps: no file transfer
  for `device.exec`, no pseudo-terminal, a dispatched request whose uplink
  drops, a lease that survives a gateway restart it cannot be renewed
  through, and local agents sharing a worker's capacity with the fleet.
- reserve "gateway" for ADR 0005's meaning: the `src/http` frontend is called
  the **HTTP frontend** throughout `docs/ARCHITECTURE.md`,
  `docs/HTTP-API.md`, and `docs/known-pitfalls.md`, where it used to be "the
  HTTP gateway". No behaviour changes; one word now means one thing. ADRs
  0003 and 0004 keep the old wording deliberately — an accepted record says
  what it said when it was accepted, and is never edited to match a later
  vocabulary.

## [0.4.0](https://github.com/callstackincubator/simlock/compare/v0.2.0...v0.4.0) (2026-10-30)

### What's Changed
* feat(http): expose the control plane over HTTP by @V3RON in https://github.com/callstackincubator/simlock/pull/68
* feat: on-demand component installation for iOS runtimes and Android system images by @V3RON in https://github.com/callstackincubator/simlock/pull/69
* feat(ios): opt-in slim simulators (closes #87) by @V3RON in https://github.com/callstackincubator/simlock/pull/89
* fix(daemon): let the daemon exit while a detached lease is outstanding by @V3RON in https://github.com/callstackincubator/simlock/pull/90
* docs(adr): 0003 — one typed daemon contract behind every frontend by @V3RON in https://github.com/callstackincubator/simlock/pull/92
* feat(contract): declare every daemon operation once, negotiate protocol ranges by @V3RON in https://github.com/callstackincubator/simlock/pull/93
* feat(daemon): one dispatcher for every transport, roles, ownership, admin credential by @V3RON in https://github.com/callstackincubator/simlock/pull/94
* feat(client): a typed, single-connection daemon client by @V3RON in https://github.com/callstackincubator/simlock/pull/95
* feat(cli): render the contract; move token operations into the daemon by @V3RON in https://github.com/callstackincubator/simlock/pull/96
* feat(mcp): derive tool schemas from the contract, delete the session cache by @V3RON in https://github.com/callstackincubator/simlock/pull/97
* fix(contract): a lease grant returns a device projection, not the whole record by @V3RON in https://github.com/callstackincubator/simlock/pull/98
* docs: document the contract, the client, the security model, and 0.3.0's breaks by @V3RON in https://github.com/callstackincubator/simlock/pull/99
* fix(client): make abort actually cancel, and keep the mismatch escape hatch alive by @V3RON in https://github.com/callstackincubator/simlock/pull/100
* fix(daemon,http): one error table for both transports; fail a bind failure loudly by @V3RON in https://github.com/callstackincubator/simlock/pull/102
* fix(mcp,contract): scope lease_status to this session; restore the §1 boundary test by @V3RON in https://github.com/callstackincubator/simlock/pull/103
* fix(client): stop swallowing a second crash on the same lease by @V3RON in https://github.com/callstackincubator/simlock/pull/104
* fix(contract,daemon): narrow status.get, close the stop-during-start window by @V3RON in https://github.com/callstackincubator/simlock/pull/105
* fix(http,mcp,docs): one answer per operation across transports by @V3RON in https://github.com/callstackincubator/simlock/pull/106
* test(cli): restore coverage deleted under a false justification by @V3RON in https://github.com/callstackincubator/simlock/pull/107
* fix(daemon): reject instead of hanging when the socket claim loses the race by @V3RON in https://github.com/callstackincubator/simlock/pull/108
* feat(devices): Simlock-owned device roots for iOS and Android by @V3RON in https://github.com/callstackincubator/simlock/pull/111
* fix: resolve hardware verification findings B2, D1, D2, D3 by @V3RON in https://github.com/callstackincubator/simlock/pull/113
* docs(adr): 0004 TTL-first leases, 0005 gateway and worker modes by @V3RON in https://github.com/callstackincubator/simlock/pull/121
* docs: describe TTL-first leases end state, accept ADR 0004 (PR C) by @V3RON in https://github.com/callstackincubator/simlock/pull/122
* chore: ignore agent worktrees under .claude/worktrees/ by @V3RON in https://github.com/callstackincubator/simlock/pull/133
* docs: describe gateway and worker modes end state, accept ADR 0005 (#120) by @V3RON in https://github.com/callstackincubator/simlock/pull/127
* feat(cli,mcp)!: clients renew their own leases (ADR 0004, PR A) by @V3RON in https://github.com/callstackincubator/simlock/pull/124
* feat!(daemon,contract): one TTL-first lease on every transport (ADR 0004, PR B) by @V3RON in https://github.com/callstackincubator/simlock/pull/125
* feat(contract,daemon,http,cli): device.exec runs simctl/adb on the worker and streams output (ADR 0005, #116) by @V3RON in https://github.com/callstackincubator/simlock/pull/128
* feat(gateway,ports,http,cli): gateway skeleton — config.mode, uplink, worker views, worker.* (ADR 0005, #117) by @V3RON in https://github.com/callstackincubator/simlock/pull/129
* feat(gateway,core,contract,daemon): fleet queue, routing, and lease + exec forwarding (ADR 0005, #118) by @V3RON in https://github.com/callstackincubator/simlock/pull/130
* test(gateway,e2e): prove drain, WORKER_UNREACHABLE and reconnect rebuild end to end (ADR 0005, #119) by @V3RON in https://github.com/callstackincubator/simlock/pull/131
* test(e2e): prove the gateway happy path over the CLI and HTTP (ADR 0005) by @V3RON in https://github.com/callstackincubator/simlock/pull/132
* fix(lefthook): exclude docs/** from the format pre-commit job by @V3RON in https://github.com/callstackincubator/simlock/pull/135
* docs: split end-user docs from maintainer/agent docs by @V3RON in https://github.com/callstackincubator/simlock/pull/134
* docs(delivery): GitHub Issues as spec and queue — kind:state labels, issue forms, spec templates by @V3RON in https://github.com/callstackincubator/simlock/pull/136
* chore(skills): spec-session, triage-bug, and deliver skills for the delivery rule by @V3RON in https://github.com/callstackincubator/simlock/pull/137
* ci(issues): enforce the delivery label rules with one issue-state workflow by @V3RON in https://github.com/callstackincubator/simlock/pull/138
* docs(delivery),chore(skills): plain-language rule and triage fixes from the first live triage by @V3RON in https://github.com/callstackincubator/simlock/pull/140
* docs(delivery),chore(skills),ci(issues): blocked state, task demotion, request close, claim release by @V3RON in https://github.com/callstackincubator/simlock/pull/142
* fix(ios): write the download-lock separator as \0 instead of a raw NUL byte by @V3RON in https://github.com/callstackincubator/simlock/pull/143
* feat(core): create a new device identity for each lease under lease.identity fresh by @V3RON in https://github.com/callstackincubator/simlock/pull/145
* docs(delivery),chore(skills): two blind reviews before every PR — rule 14 and the review skill by @V3RON in https://github.com/callstackincubator/simlock/pull/146
* feat(cli,mcp): take the requester id from the agent session by @V3RON in https://github.com/callstackincubator/simlock/pull/165
* fix(ios): report downloaded runtimes whose disk nothing can reclaim by @V3RON in https://github.com/callstackincubator/simlock/pull/144
* feat(config,android): configure emulator launch options from the config file (#148) by @V3RON in https://github.com/callstackincubator/simlock/pull/149
* docs(adr): 0006 — events and the daemon log are two records; docs follow the implementing PR by @V3RON in https://github.com/callstackincubator/simlock/pull/175
* test(e2e): stop gateway and restart tests from sitting out 30s waits by @V3RON in https://github.com/callstackincubator/simlock/pull/176
* docs(adr): 0007 — a lease request chooses the device mode by @V3RON in https://github.com/callstackincubator/simlock/pull/182
* docs(adr): 0008 — the catalog pairs models with runtimes, and status carries host facts by @V3RON in https://github.com/callstackincubator/simlock/pull/183
* feat(core,http): store lease requests and replay them by idempotency key by @V3RON in https://github.com/callstackincubator/simlock/pull/185
* feat(bus,cli,config): keep business events on disk so the history survives a restart by @V3RON in https://github.com/callstackincubator/simlock/pull/184
* feat(daemon,cli): daemon log records every request and background failure; daemon logs --follow by @V3RON in https://github.com/callstackincubator/simlock/pull/187
* docs(adr): 0009 — gateway routing is a list of stages, and a request that cannot be served fails at once by @V3RON in https://github.com/callstackincubator/simlock/pull/196
* refactor(gateway): routing is an ordered list of stages by @V3RON in https://github.com/callstackincubator/simlock/pull/197
* feat(catalog,gateway,cli): the catalog pairs each model with its installed runtimes by @V3RON in https://github.com/callstackincubator/simlock/pull/198
* feat(contract,core,http,cli): report the device mode as mode on every surface by @V3RON in https://github.com/callstackincubator/simlock/pull/199
* test(e2e): read the nested lease grant in the slow lanes by @V3RON in https://github.com/callstackincubator/simlock/pull/200
* feat(gateway): a worker that answers NO_CAPACITY is asked once per change of its state by @V3RON in https://github.com/callstackincubator/simlock/pull/201
* feat(daemon,gateway,cli): status and the worker list report host facts by @V3RON in https://github.com/callstackincubator/simlock/pull/203
* feat(catalog,gateway,cli): the catalog lists every accepted Android name and every installed image by @V3RON in https://github.com/callstackincubator/simlock/pull/202
* feat(contract,core,ios,cli,http,gateway): a lease request chooses slim or full; ios.defaultMode sets the default by @V3RON in https://github.com/callstackincubator/simlock/pull/204
* feat(gateway): a worker is sent only requests its catalog says it can serve by @V3RON in https://github.com/callstackincubator/simlock/pull/207
* docs(adr): 0010 — components are installed, recorded and removed through one owner in the core by @V3RON in https://github.com/callstackincubator/simlock/pull/222
* feat(core,contract,daemon,gateway,cli): count each device against the RAM budget by its mode, and report the budget in status by @V3RON in https://github.com/callstackincubator/simlock/pull/223
* test(e2e): the slim lane reaches Simlock's device set, and the suite keeps one test per claim by @V3RON in https://github.com/callstackincubator/simlock/pull/205
* fix(ios,docs): stop saying iOS runtimes cannot be downloaded by @V3RON in https://github.com/callstackincubator/simlock/pull/224
* feat(core,ios,android,daemon): lease-triggered downloads go through one installer in the core by @V3RON in https://github.com/callstackincubator/simlock/pull/225
* feat(core,contract,daemon,gateway,cli): status lists the installs in progress by @V3RON in https://github.com/callstackincubator/simlock/pull/227
* feat(contract,daemon,http,cli,client): simlock component install installs a component from the CLI, the client and HTTP by @V3RON in https://github.com/callstackincubator/simlock/pull/228
* feat(core,ios,android,contract,daemon,cli,client,http): simlock component list shows every installed component, its size, and who installed it by @V3RON in https://github.com/callstackincubator/simlock/pull/229
* feat(android,contract,gateway,cli): mark custom Android models in the catalog, and document where models come from by @V3RON in https://github.com/callstackincubator/simlock/pull/230
* feat(core,drivers,daemon,cli,contract): doctor names each missing prerequisite and how to install it by @V3RON in https://github.com/callstackincubator/simlock/pull/231
* feat(contract,gateway,daemon,http,cli,client): simlock component install installs on a gateway's workers by @V3RON in https://github.com/callstackincubator/simlock/pull/232
* feat(core,contract,http,mcp): a lease request reports the downloading stage while it waits on a download by @V3RON in https://github.com/callstackincubator/simlock/pull/233
* feat(core,ios,android,contract,daemon,cli,client,http,gateway): simlock component remove removes a component Simlock installed by @V3RON in https://github.com/callstackincubator/simlock/pull/234
* feat(core,contract,drivers,gateway,cli,http,mcp): a lease request names the Android image tag by @V3RON in https://github.com/callstackincubator/simlock/pull/235
* docs(cli): a gateway routes a request that uses a model's other name by @V3RON in https://github.com/callstackincubator/simlock/pull/244
* fix(drivers): a devices.xml that cannot be checked is unreadable, not a catalog failure by @V3RON in https://github.com/callstackincubator/simlock/pull/245
* fix(core): one driver's failing catalog no longer fails catalog.get for every platform by @V3RON in https://github.com/callstackincubator/simlock/pull/246
* fix(core): wake the lease queue after every handoff grant by @V3RON in https://github.com/callstackincubator/simlock/pull/247
* feat(ios,core,docs): component remove removes an iOS runtime whose only other simulators were never used by @V3RON in https://github.com/callstackincubator/simlock/pull/249
* fix(android): cancel the shutdown wait's timer so a stopped daemon exits by @V3RON in https://github.com/callstackincubator/simlock/pull/250
* fix(android): list a devices.xml profile avdmanager also prints in customModels by @V3RON in https://github.com/callstackincubator/simlock/pull/248
* fix(ports,drivers): read an installer's progress at each carriage return by @V3RON in https://github.com/callstackincubator/simlock/pull/251
* fix(android): read devices.xml RAM from <d:ram unit>, the shape Android Studio writes by @V3RON in https://github.com/callstackincubator/simlock/pull/262
* fix(drivers): read an installer's percentage written with a decimal comma by @V3RON in https://github.com/callstackincubator/simlock/pull/265
* fix(core): a removal of a recorded version that is no longer installed says none is installed by @V3RON in https://github.com/callstackincubator/simlock/pull/267
* fix(ios): wait while simctl lists a removed runtime as deleting before verifying the removal by @V3RON in https://github.com/callstackincubator/simlock/pull/268
* docs(adr): 0010 is Accepted by @V3RON in https://github.com/callstackincubator/simlock/pull/281
* fix(core,daemon): redact gateway.token in the start log line and daemon.started by @V3RON in https://github.com/callstackincubator/simlock/pull/279
* fix(docs): move loop.md to docs/internal/ and drop HTTP-API.md's internal-doc pointer by @V3RON in https://github.com/callstackincubator/simlock/pull/278
* fix(android): refuse to ready a device another emulator answers for by @V3RON in https://github.com/callstackincubator/simlock/pull/282
* fix(android): skip a console port another instance's emulator is listening on by @V3RON in https://github.com/callstackincubator/simlock/pull/269
* test(android): the two-instance fake answers emu avd path by @V3RON in https://github.com/callstackincubator/simlock/pull/287
* fix(cli): write config.json owner-only from config set by @V3RON in https://github.com/callstackincubator/simlock/pull/266
* fix(android): reserve a console port per daemon process, not per device by @V3RON in https://github.com/callstackincubator/simlock/pull/283
* fix(http,gateway): serve GET /v1/leases/{id} on a gateway and name the worker on its leases by @V3RON in https://github.com/callstackincubator/simlock/pull/285
* fix(ios,core,daemon): state the leftover download's measured size, round progress fractions, and end a successful install at 100% by @V3RON in https://github.com/callstackincubator/simlock/pull/290
* docs(adr): 0011–0013 — the web console by @V3RON in https://github.com/callstackincubator/simlock/pull/277
* feat(contract,daemon,http,docs): a worker answers the fleet operations as a fleet of one by @V3RON in https://github.com/callstackincubator/simlock/pull/288
* feat(ui,http,cli,docs): the daemon serves a web console at / with operator sign-in by @V3RON in https://github.com/callstackincubator/simlock/pull/289
* feat(ui,docs): live data and the workers views in the console by @V3RON in https://github.com/callstackincubator/simlock/pull/291
* feat(console,cli,http): waiting requests view and simlock list --requests by @V3RON in https://github.com/callstackincubator/simlock/pull/296
* feat(ui,core,daemon,cli): attention view and stalled devices by @V3RON in https://github.com/callstackincubator/simlock/pull/295
* feat(ui,http,docs): leases view, lease details and holder labels in the console by @V3RON in https://github.com/callstackincubator/simlock/pull/293
* feat(ui,docs): the events view in the console by @V3RON in https://github.com/callstackincubator/simlock/pull/294
* feat(ui): the Apex look in the console by @V3RON in https://github.com/callstackincubator/simlock/pull/298
* feat(ui,docs,e2e): page every console table and draw only the events in view by @V3RON in https://github.com/callstackincubator/simlock/pull/300
* test: close audit gaps — cleanup --rule, per-boot address, one admission check, boundary scans, timeout tests by @V3RON in https://github.com/callstackincubator/simlock/pull/303
* refactor: delete production code only tests kept alive (audit step 2) by @V3RON in https://github.com/callstackincubator/simlock/pull/304
* refactor(gateway): retire the legacy routing policy only tests ran (audit step 3) by @V3RON in https://github.com/callstackincubator/simlock/pull/306
* test: delete tests a stronger keeper already proves (audit step 4) by @V3RON in https://github.com/callstackincubator/simlock/pull/308
* fix(core): a daemon that loses the identity race reads the winner's id, not an empty file by @V3RON in https://github.com/callstackincubator/simlock/pull/302
* chore(agents): unattended delivery — orchestrator, forked stages, merge gate, mutation testing by @V3RON in https://github.com/callstackincubator/simlock/pull/301
* chore(agents): weekly delivery stats, tests-after-red for the spec review, releases from a workflow by @V3RON in https://github.com/callstackincubator/simlock/pull/313
* feat(gateway): a request no worker can serve fails at once by @V3RON in https://github.com/callstackincubator/simlock/pull/310
* feat(bus): every event carries an id that survives a restart by @V3RON in https://github.com/callstackincubator/simlock/pull/322
* feat(gateway): retry a worker's cannot-serve refusal on another worker by @V3RON in https://github.com/callstackincubator/simlock/pull/315
* feat(bus): a relayed event keeps the worker's id and timestamp by @V3RON in https://github.com/callstackincubator/simlock/pull/323
* feat(gateway): the pick accounts for health, the worker's queue, and its RAM budget by @V3RON in https://github.com/callstackincubator/simlock/pull/321
* docs(adr): 0014 — an event has one id, minted where the fact happened by @V3RON in https://github.com/callstackincubator/simlock/pull/311
* docs(adr): 0015 — a lease request is a set of constraints, and the catalog says which class each model is by @V3RON in https://github.com/callstackincubator/simlock/pull/330
* chore(agents): severity-gated reviews, review inputs script, spec check before ready, assumptions by @V3RON in https://github.com/callstackincubator/simlock/pull/331
* chore(agents): pin model and effort for every delivery stage, reviewers as agent definitions by @V3RON in https://github.com/callstackincubator/simlock/pull/338
* chore(agents): delivery stats read GitHub through repo-scoped endpoints only by @V3RON in https://github.com/callstackincubator/simlock/pull/339
* feat(catalog): the catalog names each model's class by @V3RON in https://github.com/callstackincubator/simlock/pull/340
* feat(catalog): the catalog shows the default model per class (#333) by @V3RON in https://github.com/callstackincubator/simlock/pull/342
* docs(adr): 0016 — usage figures are derived on read from the event history by @V3RON in https://github.com/callstackincubator/simlock/pull/344
* feat(lease): a request names a class or nothing, and is served by a fitting idle device first by @V3RON in https://github.com/callstackincubator/simlock/pull/343
* feat(events): events carry the grant facts; capacity and queue depth become events by @V3RON in https://github.com/callstackincubator/simlock/pull/351
* feat(events): the event log keeps a window of time, bounded by size by @V3RON in https://github.com/callstackincubator/simlock/pull/353
* feat(lease): --os accepts a version range by @V3RON in https://github.com/callstackincubator/simlock/pull/352
* chore(agents): faster delivery runs and specs a person can follow by @V3RON in https://github.com/callstackincubator/simlock/pull/355
* feat(gateway): warm hits respect the request's mode and the runtime the worker would pick by @V3RON in https://github.com/callstackincubator/simlock/pull/325
* feat(gateway): a class or range request is served by a worker that fits by @V3RON in https://github.com/callstackincubator/simlock/pull/357
* docs(adr): 0017 — the warm pool is a module beside the lease transaction, not a step in it by @V3RON in https://github.com/callstackincubator/simlock/pull/361
* docs(adr): 0017 is accepted, not yet implemented by @V3RON in https://github.com/callstackincubator/simlock/pull/367
* docs(adr): 0018–0019 — leasing is one module, and startup ends every lease whose device is not running by @V3RON in https://github.com/callstackincubator/simlock/pull/360
* chore(agents): run delivery stages as background custom agents by @V3RON in https://github.com/callstackincubator/simlock/pull/376
* chore(agents): implementer audits its diff before reporting by @V3RON in https://github.com/callstackincubator/simlock/pull/377
* chore(agents): session titles and status lines show delivery progress by @V3RON in https://github.com/callstackincubator/simlock/pull/378
* feat(lint): imports past a module's index into core or gateway fail lint by @V3RON in https://github.com/callstackincubator/simlock/pull/374
* chore(agents): agents run only the tests their change reaches; hooks run the other checks by @V3RON in https://github.com/callstackincubator/simlock/pull/379
* chore(test): run fast e2e files four at a time by @V3RON in https://github.com/callstackincubator/simlock/pull/380
* chore(agents): a session stops itself when it passes a token or time budget by @V3RON in https://github.com/callstackincubator/simlock/pull/384
* chore(agents): implementer never runs hook checks by hand, never waits on CI, never stashes by @V3RON in https://github.com/callstackincubator/simlock/pull/385
* refactor(core): reclaim is its own coordinator and commits what the driver returns by @V3RON in https://github.com/callstackincubator/simlock/pull/375
* feat(core): the warm pool module: one budget, a keep rule that fits, and an off switch by @V3RON in https://github.com/callstackincubator/simlock/pull/386
* chore(agents): agents and skills take every command from toolchain.md, and say it in fewer words by @V3RON in https://github.com/callstackincubator/simlock/pull/390
* chore(agents): review converges: a claims review, two code-review lenses, later rounds review only the fix by @V3RON in https://github.com/callstackincubator/simlock/pull/391
* chore(agents): the spec check plans, runs a pre-mortem and gives every category a status by @V3RON in https://github.com/callstackincubator/simlock/pull/392
* refactor(leasing): leasing is its own module, entered through src/leasing/index.ts by @V3RON in https://github.com/callstackincubator/simlock/pull/383
* fix(leasing): a grant and its request's result are one write by @V3RON in https://github.com/callstackincubator/simlock/pull/397
* feat(core): a reserve of running slots, and a request waits for a device on its way by @V3RON in https://github.com/callstackincubator/simlock/pull/394
* feat(contract): status answers only health and host while the daemon is starting by @V3RON in https://github.com/callstackincubator/simlock/pull/398
* feat(core): warm targets boot or create devices ahead of demand by @V3RON in https://github.com/callstackincubator/simlock/pull/408
* feat(leasing): startup ends every lease whose device is not running by @V3RON in https://github.com/callstackincubator/simlock/pull/409
* chore(ci): the console lane runs on a PR only when it changes what the lane exercises, in Chromium only by @V3RON in https://github.com/callstackincubator/simlock/pull/413
* chore(agents): review rounds run while they converge, every stage is a new agent, and a spec fix is checked closed by @V3RON in https://github.com/callstackincubator/simlock/pull/415
* chore(agents): the gate re-runs CI once for a missing runner or a known flaky test, and the budget guard counts only active time by @V3RON in https://github.com/callstackincubator/simlock/pull/416
* feat(core): the warm pool in status, doctor, one event and the console by @V3RON in https://github.com/callstackincubator/simlock/pull/411
* docs(adr): a requester may choose its lease id (ADR 0020) by @V3RON in https://github.com/callstackincubator/simlock/pull/418
* fix(leasing): wake the queue after a failed boot whose destroy also fails by @V3RON in https://github.com/callstackincubator/simlock/pull/426
* fix(daemon): dial the gateway uplink from onSocketClaimed by @V3RON in https://github.com/callstackincubator/simlock/pull/427
* feat(leasing): let requesters choose the lease ID by @V3RON in https://github.com/callstackincubator/simlock/pull/423
* fix(gateway): a worker that was starting when first read gets its full view once its startup ends by @V3RON in https://github.com/callstackincubator/simlock/pull/421
* fix(leasing): free the waiter's running slot when a failed boot's device is claimed before the destroy by @V3RON in https://github.com/callstackincubator/simlock/pull/425
* docs(adr): a gateway dispatch is a probe, and the gateway records every fleet request's outcome (ADR 0021) by @V3RON in https://github.com/callstackincubator/simlock/pull/432
* feat(leasing): a gateway dispatch is a probe; workers record lease.declined, the gateway records every fleet outcome by @V3RON in https://github.com/callstackincubator/simlock/pull/433
* test(e2e): slow lane: a target boots a real simulator and emulator, and off shuts both down by @V3RON in https://github.com/callstackincubator/simlock/pull/419
* docs(adr): a physical device is a second device type the core knows (ADR 0022) by @V3RON in https://github.com/callstackincubator/simlock/pull/435
* docs(adr): ADR 0022 amendments from the #428 spec check by @V3RON in https://github.com/callstackincubator/simlock/pull/443
* chore(agents): comments say why or go; a Haiku comment review; incremental mutation testing by @V3RON in https://github.com/callstackincubator/simlock/pull/446
* chore(agents): implementer in phases, restricted tools, raw hand-offs, coding.md by @V3RON in https://github.com/callstackincubator/simlock/pull/447
* feat(core): core knows physical devices: the device union, its state machine, and virtual-only paths leave them alone by @V3RON in https://github.com/callstackincubator/simlock/pull/444
* chore(agents): CI failures reach fix runs; audit runs the comment review; fewer pushes; Stryker failures say why by @V3RON in https://github.com/callstackincubator/simlock/pull/452
* feat(enrollment): simlock device add / remove enroll and unenroll physical devices by @V3RON in https://github.com/callstackincubator/simlock/pull/449
* fix(core): doctor and the lease health monitor make their registry writes in the decision section by @V3RON in https://github.com/callstackincubator/simlock/pull/454
* test(daemon): wait for leasing's held startup write, not 25 ms of real time by @V3RON in https://github.com/callstackincubator/simlock/pull/453
* fix(daemon): a frame for a peer that hung up is dropped, not an unhandled rejection that kills the daemon by @V3RON in https://github.com/callstackincubator/simlock/pull/457
* fix(e2e): withDaemon waits for admin.token before handing the daemon over by @V3RON in https://github.com/callstackincubator/simlock/pull/455
* feat(leasing): lease --physical grants, queues and reclaims enrolled physical devices by @V3RON in https://github.com/callstackincubator/simlock/pull/456
* chore(agents): faster delivery: no Stryker on push, foreground helpers, report and budget guards, reviews sized to the diff by @V3RON in https://github.com/callstackincubator/simlock/pull/459
* chore(agents): comment lint, two review rounds, briefs, agent caps and delivery measurement by @V3RON in https://github.com/callstackincubator/simlock/pull/460
* feat(leasing): physical devices that go missing become absent, end their lease device-lost, and come back reclaimed by @V3RON in https://github.com/callstackincubator/simlock/pull/458
* feat(ios): iOS physical devices through devicectl by @V3RON in https://github.com/callstackincubator/simlock/pull/461
* feat(android): physical Android devices through the host's default adb server by @V3RON in https://github.com/callstackincubator/simlock/pull/462
* feat(gateway): remote agents lease and reach physical devices on workers by @V3RON in https://github.com/callstackincubator/simlock/pull/463
* docs(adr): agent-device edge module and lease-end port (ADRs 0023, 0024) by @V3RON in https://github.com/callstackincubator/simlock/pull/467
* feat(leasing): an agent id may hold more than one lease, up to lease.maxPerRequester by @V3RON in https://github.com/callstackincubator/simlock/pull/468
* docs(adr): ADR 0023 amendments from the #466 spec check by @V3RON in https://github.com/callstackincubator/simlock/pull/478
* docs(events): list lease-engine among device.deleted initiators by @V3RON in https://github.com/callstackincubator/simlock/pull/479
* docs(console): show simlock status's real output by @V3RON in https://github.com/callstackincubator/simlock/pull/480
* fix(events): list cleanup-reaper and nuke as device.deleted initiators by @V3RON in https://github.com/callstackincubator/simlock/pull/482
* docs(adr): 0025 — Simlock ships Android device profiles, and a model pairs only with images that fit it by @V3RON in https://github.com/callstackincubator/simlock/pull/486
* docs(adr): 0025 amendments from the #485 spec check by @V3RON in https://github.com/callstackincubator/simlock/pull/492
* test(e2e): commit prebuilt Appduct playground apps as fixtures by @V3RON in https://github.com/callstackincubator/simlock/pull/493
* feat(leasing): call lease-end participants before reclaiming a device by @V3RON in https://github.com/callstackincubator/simlock/pull/494
* feat(agent-device): simlock runs the agent-device daemon by @V3RON in https://github.com/callstackincubator/simlock/pull/495
* feat(doctor): simlock doctor says why agent-device is not available by @V3RON in https://github.com/callstackincubator/simlock/pull/496
* feat(agent-device): an agent opens and closes a device through simlock by @V3RON in https://github.com/callstackincubator/simlock/pull/497
* chore(reviews): calibration brief for the four weeks to 2026-10-13 by @V3RON in https://github.com/callstackincubator/simlock/pull/498
* feat(agent-device): heartbeats keep the simlock lease alive by @V3RON in https://github.com/callstackincubator/simlock/pull/499
* chore(fallow): remove four stale suppressions and fail on stale ones by @V3RON in https://github.com/callstackincubator/simlock/pull/500
* test(e2e): spend less time waiting by @V3RON in https://github.com/callstackincubator/simlock/pull/504
* test(e2e): a failed warm-pool boot is held back, checked in 2 s instead of a 60 s wait by @V3RON in https://github.com/callstackincubator/simlock/pull/503
* ci: split Quality into parallel static, unit and sharded e2e jobs by @V3RON in https://github.com/callstackincubator/simlock/pull/501
* chore(agents): one worktree per task, hook guards, decide-and-tell, stacked feature PRs by @V3RON in https://github.com/callstackincubator/simlock/pull/505
* chore(agents): the weekday routines finish in a cloud session by @V3RON in https://github.com/callstackincubator/simlock/pull/502
* test(ports): process runner waits are constructor options by @V3RON in https://github.com/callstackincubator/simlock/pull/382
* feat(agent-device): simlock ending a simlock lease ends the agent-device session first by @V3RON in https://github.com/callstackincubator/simlock/pull/506
* feat(agent-device): the front refuses requests that reach past the agent's device by @V3RON in https://github.com/callstackincubator/simlock/pull/507
* test(e2e): agent-device through a simlock worker on real devices by @V3RON in https://github.com/callstackincubator/simlock/pull/509
* feat(android): Simlock ships its own Pixel 9 Android profile, read before the SDK by @V3RON in https://github.com/callstackincubator/simlock/pull/521
* feat(android): the other 15 library profiles, and Medium Tablet as Android's tablet by @V3RON in https://github.com/callstackincubator/simlock/pull/523
* feat(android): an Android lease only uses a system image that fits its model by @V3RON in https://github.com/callstackincubator/simlock/pull/526
* feat(android): a devices.xml profile's API range, Play Store and screen size decide its images by @V3RON in https://github.com/callstackincubator/simlock/pull/530
* feat(android): doctor reports a devices.xml profile hidden by a library profile by @V3RON in https://github.com/callstackincubator/simlock/pull/535
* chore(comments): delete comments that say what, not why, since b2c5b2e by @V3RON in https://github.com/callstackincubator/simlock/pull/541
* chore(reviews): calibration brief for the four weeks to 2026-10-14 by @V3RON in https://github.com/callstackincubator/simlock/pull/540
* docs(adr): 0026 agent-device through a gateway by @V3RON in https://github.com/callstackincubator/simlock/pull/512
* feat(fleet): workers advertise their capabilities in status and worker list by @V3RON in https://github.com/callstackincubator/simlock/pull/520
* feat(fleet): a lease request may require a capability by @V3RON in https://github.com/callstackincubator/simlock/pull/524
* feat(gateway): relay one HTTP exchange to a module on a worker by @V3RON in https://github.com/callstackincubator/simlock/pull/528
* feat(agent-device): open, commands, heartbeats and close through a gateway by @V3RON in https://github.com/callstackincubator/simlock/pull/536
* feat(agent-device): devices, uploads, artifacts and diagnostics through a gateway by @V3RON in https://github.com/callstackincubator/simlock/pull/537
* feat(agent-device): an unreachable worker answers try again, and a gateway restart keeps the agent's device by @V3RON in https://github.com/callstackincubator/simlock/pull/539
* test(e2e): agent-device through a gateway on real devices by @V3RON in https://github.com/callstackincubator/simlock/pull/538
* chore(agents): specs cite their facts, and a split ends with tasks ready by @V3RON in https://github.com/callstackincubator/simlock/pull/548
* chore(agents): the hardware loop, a slow lane that reports and cleans up, and no dialogs in delivery by @V3RON in https://github.com/callstackincubator/simlock/pull/549
* chore(agents): audits probe every test, reviews stop overlapping, searches go to Haiku by @V3RON in https://github.com/callstackincubator/simlock/pull/550
* chore(agents): modules hand out capabilities, extension points share one shape, and dependency-cruiser guards every component (ADR 0027) by @V3RON in https://github.com/callstackincubator/simlock/pull/555
* fix(cli): daemon start reports the config error instead of a socket timeout by @V3RON in https://github.com/callstackincubator/simlock/pull/543
* fix(e2e): a daemon on a free port picks another when the port is taken before it binds by @V3RON in https://github.com/callstackincubator/simlock/pull/560
* chore: typechecks reuse a local tsbuildinfo cache between runs by @V3RON in https://github.com/callstackincubator/simlock/pull/572
* docs(adr): 0028 the uplink carries byte channels and small messages go first by @V3RON in https://github.com/callstackincubator/simlock/pull/554
* feat(agent-device): a download over 2 GB fails, never cut short by @V3RON in https://github.com/callstackincubator/simlock/pull/561
* feat(link): the uplink carries byte channels beside its messages, and small messages go first by @V3RON in https://github.com/callstackincubator/simlock/pull/562
* feat(gateway): relayed bodies travel on byte channels by @V3RON in https://github.com/callstackincubator/simlock/pull/570
* test(e2e): transfers through a gateway keep their promises by @V3RON in https://github.com/callstackincubator/simlock/pull/571
* docs(adr): 0027 host load is an optional module whose readings ride on status by @V3RON in https://github.com/callstackincubator/simlock/pull/529
* feat(host-load): a worker's simlock status shows its CPU, memory and disk load by @V3RON in https://github.com/callstackincubator/simlock/pull/563
* feat(host-load): Linux load is measured against a cgroup v2 limit by @V3RON in https://github.com/callstackincubator/simlock/pull/565
* feat(gateway): a gateway carries each worker's load in its view and reports its own by @V3RON in https://github.com/callstackincubator/simlock/pull/567
* feat(ui): the console shows each worker's load on its card and detail page by @V3RON in https://github.com/callstackincubator/simlock/pull/568
* docs(readme): add the global install step to Getting started by @alcpereira in https://github.com/callstackincubator/simlock/pull/167
* chore(comments): delete comments that say what, not why, since b2f9a95 by @V3RON in https://github.com/callstackincubator/simlock/pull/578
* refactor(link): the link needs no Node, so it can move to a browser or its own package by @V3RON in https://github.com/callstackincubator/simlock/pull/579
* docs(adr): record which accepted ADRs the code now implements by @V3RON in https://github.com/callstackincubator/simlock/pull/589
* fix(daemon): the daemon reports the version in package.json by @V3RON in https://github.com/callstackincubator/simlock/pull/588
* chore(docs): every module has a manual beside its code by @V3RON in https://github.com/callstackincubator/simlock/pull/581
* chore(docs): ARCHITECTURE.md becomes the map by @V3RON in https://github.com/callstackincubator/simlock/pull/582
* chore(docs): known gaps move into the manuals; COMPONENTS, KNOWN-PITFALLS, LOOP and drafts go by @V3RON in https://github.com/callstackincubator/simlock/pull/583
* chore(testing): fewer, stronger tests — new testing rules, a leasing pilot, and a weekly audit-tests routine by @V3RON in https://github.com/callstackincubator/simlock/pull/604
* chore(agent-device): require agent-device 0.21.28 and take its proxy from npm by @V3RON in https://github.com/callstackincubator/simlock/pull/603
* fix(agent-device): release the simlock lease when a command reports endedLeases by @V3RON in https://github.com/callstackincubator/simlock/pull/608
* docs(adr): 0030 optional modules share one contract and load only when turned on by @V3RON in https://github.com/callstackincubator/simlock/pull/592
* feat(doctor): one module-unavailable finding for every optional module by @V3RON in https://github.com/callstackincubator/simlock/pull/599
* feat(modules): optional modules load through one host and are turned on under capabilities by @V3RON in https://github.com/callstackincubator/simlock/pull/601
* feat(agent-device): agent-device runs as an optional module on workers by @V3RON in https://github.com/callstackincubator/simlock/pull/605
* feat(agent-device): the gateway side runs as an optional module by @V3RON in https://github.com/callstackincubator/simlock/pull/606
* feat(stream): a leased simulator's or emulator's screen, streamed to whoever is looking at it by @V3RON in https://github.com/callstackincubator/simlock/pull/576
* feat(ui): the console draws each worker's load as gauges on its detail page by @V3RON in https://github.com/callstackincubator/simlock/pull/575
* feat(ui): the load gauges colour over the console's own thresholds by @V3RON in https://github.com/callstackincubator/simlock/pull/586
* chore(comments): delete comments that say what, not why, since df35f28 by @V3RON in https://github.com/callstackincubator/simlock/pull/611
* feat(ui): console redesign — sidebar, overview, list and inspector pages, a design system by @V3RON in https://github.com/callstackincubator/simlock/pull/610
* fix(agent-device): release the simlock lease when close is streamed without --json by @V3RON in https://github.com/callstackincubator/simlock/pull/615
* fix: wait for the iOS app installer before readiness by @V3RON in https://github.com/callstackincubator/simlock/pull/614
* fix(http): preserve concurrent token mutations by @V3RON in https://github.com/callstackincubator/simlock/pull/616
* chore(agents): one spec session, explored first, tasks written from tables by @V3RON in https://github.com/callstackincubator/simlock/pull/621
* fix(http,core): write tokens.json and state.json owner-only (#258) by @V3RON in https://github.com/callstackincubator/simlock/pull/640
* fix(contract): retire helper import boundary exemptions by @V3RON in https://github.com/callstackincubator/simlock/pull/627
* fix(gateway): refuse to republish a worker-pushed request.dispatched by @V3RON in https://github.com/callstackincubator/simlock/pull/641
* fix(gateway): drop a worker's framing headers from a relay head by @V3RON in https://github.com/callstackincubator/simlock/pull/643
* test(e2e): wait for reclaim before cleanup preview by @V3RON in https://github.com/callstackincubator/simlock/pull/628
* fix(daemon): preserve replacement admin credential during restart by @V3RON in https://github.com/callstackincubator/simlock/pull/625
* test: daemon status prints a human view, pinned at unit cost (#422) by @V3RON in https://github.com/callstackincubator/simlock/pull/644
* fix(drivers/android): class a listed model by the profile its name resolves to by @V3RON in https://github.com/callstackincubator/simlock/pull/646
* fix(leasing): a boot failure whose destroy also fails quarantines the device and frees the slot by @V3RON in https://github.com/callstackincubator/simlock/pull/649
* fix(leasing): a ready grant marks its waiter in flight before the write (#402) by @V3RON in https://github.com/callstackincubator/simlock/pull/650
* fix(console): show fleet lease and device figures as unknown while a worker is starting by @V3RON in https://github.com/callstackincubator/simlock/pull/651
* fix(leasing): a handoff grant whose commit throws defers its waiter by @V3RON in https://github.com/callstackincubator/simlock/pull/658
* chore(comments): delete comments that say what, not why, since e25f8de by @V3RON in https://github.com/callstackincubator/simlock/pull/652
* fix(core): the warm pool skips devices of a platform whose driver was refused by @V3RON in https://github.com/callstackincubator/simlock/pull/661
* fix(core): the cleanup reaper finishes its run when one action fails by @V3RON in https://github.com/callstackincubator/simlock/pull/664
* fix(core): the operator reset finishes when one device has no driver by @V3RON in https://github.com/callstackincubator/simlock/pull/668
* fix(console): the workers-list lane helpers drop a re-read refused by a stopping gateway (#642) by @V3RON in https://github.com/callstackincubator/simlock/pull/667
* fix(leasing): the #armTimeout comment states what its markNew callers do by @V3RON in https://github.com/callstackincubator/simlock/pull/670
* fix(leasing): no device work for a waiter the queue has just rejected (#665) by @V3RON in https://github.com/callstackincubator/simlock/pull/669
* docs(agents): make exploration selective and evidence-bearing by @V3RON in https://github.com/callstackincubator/simlock/pull/655
* feat(agents): make review incremental and risk-routed by @V3RON in https://github.com/callstackincubator/simlock/pull/656
* chore(ci): bump actions/setup-node from 7.0.0 to 7.1.0 in the github-actions group by @dependabot[bot] in https://github.com/callstackincubator/simlock/pull/638
* fix(core): attribute the recovered interrupted reclaim's device.shutdown to the reclaim coordinator by @V3RON in https://github.com/callstackincubator/simlock/pull/679
* fix(cli): wait 20 s for a daemon a command auto-launched (#663) by @V3RON in https://github.com/callstackincubator/simlock/pull/674
* fix(cli): the auto-launch startup timeout reports DAEMON_STARTUP_FAILED, not INTERNAL (#672) by @V3RON in https://github.com/callstackincubator/simlock/pull/683
* fix(console): the overview's Activity lists the latest events, not the highest seq by @V3RON in https://github.com/callstackincubator/simlock/pull/680
* docs(adr): 0031 a physical iPhone streams through CoreDevice's media stream, behind a screen-source seam by @V3RON in https://github.com/callstackincubator/simlock/pull/622
* feat(drivers/android): stream a leased physical phone's screen behind a capture target by @V3RON in https://github.com/callstackincubator/simlock/pull/662
* test(ios): stream a leased physical iPhone's screen by @V3RON in https://github.com/callstackincubator/simlock/pull/645
* fix(gateway): a lone refusal after an aged-out window omits count (#677) by @V3RON in https://github.com/callstackincubator/simlock/pull/682
* fix(e2e/console): a failed daemon start reports the daemon's own cause (#673) by @V3RON in https://github.com/callstackincubator/simlock/pull/687
* fix(ports,core): write daemon.log, events.jsonl and instance.json owner-only (#685) by @V3RON in https://github.com/callstackincubator/simlock/pull/689
* perf(cli): load a command's modules only when that command runs by @V3RON in https://github.com/callstackincubator/simlock/pull/671
* Rank an installed Android image by the API level it records, so a preview is never the newest runtime by @V3RON in https://github.com/callstackincubator/simlock/pull/681
* chore(agents): spec sessions approve once, source facts while asking, and recheck only the fix by @V3RON in https://github.com/callstackincubator/simlock/pull/725
* chore(agents): one home for each procedure, short skill descriptions, AGENTS.md as a router by @V3RON in https://github.com/callstackincubator/simlock/pull/726
* docs(internal): DELIVERY.md says what the maintainer does and sees, and links to where each step is defined by @V3RON in https://github.com/callstackincubator/simlock/pull/728
* feat(history): history.db, usage projections, simlock stats, GET /v1/stats and console figures (#623) by @V3RON in https://github.com/callstackincubator/simlock/pull/626
* docs(adr): 0033 a sign-in proxy is a second way to sign in, and auth is one module by @V3RON in https://github.com/callstackincubator/simlock/pull/704
* refactor(auth): auth checks live in one module, src/auth by @V3RON in https://github.com/callstackincubator/simlock/pull/732
* feat(identity): identity.get, GET /v1/identity and simlock whoami by @V3RON in https://github.com/callstackincubator/simlock/pull/735
* feat(auth): sign in through a sign-in proxy's signed JWT by @V3RON in https://github.com/callstackincubator/simlock/pull/736
* feat(http): refuse cross-site changing requests from a proxy sign-in by @V3RON in https://github.com/callstackincubator/simlock/pull/737
* feat(console): sign in through the sign-in proxy and show who is signed in by @V3RON in https://github.com/callstackincubator/simlock/pull/738
* test(real-proxy): run Simlock behind oauth2-proxy and Dex in CI by @V3RON in https://github.com/callstackincubator/simlock/pull/740
* chore(agents): measured review and test strategy — mutation by tool, a self-filling ledger, fewer notes and tests by @V3RON in https://github.com/callstackincubator/simlock/pull/739
* fix(agent-device): stop renewing commands answered unreachable by @V3RON in https://github.com/callstackincubator/simlock/pull/723
* fix(cli): a daemon launched by daemon start that dies during that start reports DAEMON_STARTUP_FAILED by @V3RON in https://github.com/callstackincubator/simlock/pull/710
* docs(daemon): drop manual rows for files moved to src/auth by @V3RON in https://github.com/callstackincubator/simlock/pull/742
* fix(android): verify emulator identity before kill or snapshot load after a restart (#284) by @V3RON in https://github.com/callstackincubator/simlock/pull/722
* docs(adr): 0035 a gateway sends chosen fleet events to webhook destinations by @V3RON in https://github.com/callstackincubator/simlock/pull/718
* feat(alerts): a gateway sends chosen fleet events to generic webhook destinations by @V3RON in https://github.com/callstackincubator/simlock/pull/741
* feat(alerts): a gateway sends fleet events to Slack by @V3RON in https://github.com/callstackincubator/simlock/pull/744
* feat(alerts): simlock alerts test sends one sample to a destination by @V3RON in https://github.com/callstackincubator/simlock/pull/746
* feat(website): a product website on GitHub Pages by @V3RON in https://github.com/callstackincubator/simlock/pull/747
* fix(android): stop an orphan's running emulator before deleting its AVD by @V3RON in https://github.com/callstackincubator/simlock/pull/751
* docs(adr): 0034 one worker per user, and the folder says what a daemon is by @V3RON in https://github.com/callstackincubator/simlock/pull/702
* feat(daemon): the folder says what a daemon is, and --gateway reaches the gateway by @V3RON in https://github.com/callstackincubator/simlock/pull/745
* feat(cli): commands find the daemon by folder, with a --gateway hint on a worker refusal by @V3RON in https://github.com/callstackincubator/simlock/pull/749
* fix(android): prove running emulator root membership by @V3RON in https://github.com/callstackincubator/simlock/pull/733
* fix(core): startup removes dead writers' temporary files by @V3RON in https://github.com/callstackincubator/simlock/pull/752
* fix(agent-device): a lease the gateway's list omits is not ended (#750) by @V3RON in https://github.com/callstackincubator/simlock/pull/753
* docs(adr): 0036 daemon state is a SQLite database, and each owner keeps its own tables by @V3RON in https://github.com/callstackincubator/simlock/pull/755
* feat(state): the worker's registry lives in state.db by @V3RON in https://github.com/callstackincubator/simlock/pull/775
* feat(drivers): iOS and Android device-data tables by @V3RON in https://github.com/callstackincubator/simlock/pull/783
* feat(auth): tokens live in state.db on both daemon kinds by @V3RON in https://github.com/callstackincubator/simlock/pull/784
* feat(cli): the CLI and MCP show why an auto-started daemon did not start by @V3RON in https://github.com/callstackincubator/simlock/pull/785
* feat(gateway): the gateway's drained workers live in state.db by @V3RON in https://github.com/callstackincubator/simlock/pull/786
* docs(adr): 0038 the warm pool learns its kinds from leases, and boots for every queued request by @V3RON in https://github.com/callstackincubator/simlock/pull/772
* feat(warm-pool): the warm pool boots or creates one device per queued request by @V3RON in https://github.com/callstackincubator/simlock/pull/788
* feat(warm-pool): a worker with no targets keeps the kinds it has leased ready by @V3RON in https://github.com/callstackincubator/simlock/pull/792
* chore(agents): review replay harness, and the 2026-10-21 process review by @V3RON in https://github.com/callstackincubator/simlock/pull/794
* chore(agents): the process review's small fixes and counters by @V3RON in https://github.com/callstackincubator/simlock/pull/796
* chore(agents): stacks merge forward, the ADR PR is reviewed first, and CI failures are triaged before a fix run by @V3RON in https://github.com/callstackincubator/simlock/pull/798
* chore(agents): round 1 reports every site of a defect class, safety candidates are probed, mechanical fix-checks spawn no lens, the audit proves coverage by @V3RON in https://github.com/callstackincubator/simlock/pull/799
* chore(agents): AGENTS.md routes by role, the implementer carries its checklist, and briefs and the protocol ride in the prompt by @V3RON in https://github.com/callstackincubator/simlock/pull/800
* chore(agents): the feature is checked before its tasks, tests are invoker scenarios from one Behaviours table, and tasks hold about ten by @V3RON in https://github.com/callstackincubator/simlock/pull/801
* test(audit): 124 weak tests fixed, 33 fewer tests, since 56b5a49 by @V3RON in https://github.com/callstackincubator/simlock/pull/795
* fix(warm-pool): protect devices serving queued requests by @V3RON in https://github.com/callstackincubator/simlock/pull/804
* feat(website): the hero plays one machine, then a fleet of them by @V3RON in https://github.com/callstackincubator/simlock/pull/763
* docs(website): end-user docs live only on the website, rewritten as guides and lookup tables by @V3RON in https://github.com/callstackincubator/simlock/pull/816
* docs(adr): 0037 the console acts through the HTTP routes, on Base UI by @V3RON in https://github.com/callstackincubator/simlock/pull/762
* feat(history): events.replay pages back with before and limit by @V3RON in https://github.com/callstackincubator/simlock/pull/773
* feat(console): a new frame, and Leases in a drawer by @V3RON in https://github.com/callstackincubator/simlock/pull/780
* feat(console): Fleet is a table, and each worker has a page with tabs by @V3RON in https://github.com/callstackincubator/simlock/pull/787
* feat(console): Queue and Activity move to the shared frame, and Activity scrolls back through the history by @V3RON in https://github.com/callstackincubator/simlock/pull/789
* feat(console): Overview home and Inbox by @V3RON in https://github.com/callstackincubator/simlock/pull/793
* feat(console): release, cancel, drain, undrain and remove from the console by @V3RON in https://github.com/callstackincubator/simlock/pull/803
* feat(console): search or jump to anything with ⌘K by @V3RON in https://github.com/callstackincubator/simlock/pull/834
* test(audit): remove low-value tests across the suite, 140 fewer tests by @V3RON in https://github.com/callstackincubator/simlock/pull/849
* docs(adr): joined workers refuse their own HTTP listener by @V3RON in https://github.com/callstackincubator/simlock/pull/809
* feat(config): refuse HTTP on joined workers and migrate fixtures by @V3RON in https://github.com/callstackincubator/simlock/pull/842
* feat(agent-device): --os and --image-tag reach lease.request by @V3RON in https://github.com/callstackincubator/simlock/pull/840
* feat(warm-pool): status, doctor, console and docs show learned kinds with their origin by @V3RON in https://github.com/callstackincubator/simlock/pull/844
* fix(startup): reject daemon sockets closed before hello by @V3RON in https://github.com/callstackincubator/simlock/pull/805
* docs(adr): 0040 every HTTP route is declared once, and the OpenAPI document is built from the declarations by @V3RON in https://github.com/callstackincubator/simlock/pull/815
* feat(contract): move to Zod 4 by @V3RON in https://github.com/callstackincubator/simlock/pull/845
* feat(http): declare the System and Devices routes and build the OpenAPI document by @V3RON in https://github.com/callstackincubator/simlock/pull/850
* feat(website): publish openapi.json and render the HTTP API reference by @V3RON in https://github.com/callstackincubator/simlock/pull/855
* feat(http): declare the lease and lease-request routes by @V3RON in https://github.com/callstackincubator/simlock/pull/854
* feat(http): declare the admin routes in the OpenAPI document by @V3RON in https://github.com/callstackincubator/simlock/pull/857
* feat(http): the OpenAPI document lists the stream route by @V3RON in https://github.com/callstackincubator/simlock/pull/858
* test(agent-device): drop download-cap.test.ts by @V3RON in https://github.com/callstackincubator/simlock/pull/862
* docs(adr): 0041 the daemon can run under the user's service manager by @V3RON in https://github.com/callstackincubator/simlock/pull/826
* feat(daemon): SIGTERM is a clean stop, and a start beside a running daemon exits 0 by @V3RON in https://github.com/callstackincubator/simlock/pull/841
* feat(daemon): macOS service install, uninstall and supervised starts by @V3RON in https://github.com/callstackincubator/simlock/pull/856
* feat(daemon): daemon status shows the service state, doctor reports a broken service by @V3RON in https://github.com/callstackincubator/simlock/pull/859
* feat(ports): systemd user unit service manager on Linux by @V3RON in https://github.com/callstackincubator/simlock/pull/861
* fix(ci): shard the console lane over four jobs by @V3RON in https://github.com/callstackincubator/simlock/pull/868
* fix(ui): console e2e Activity:371 and Queue:163 by @V3RON in https://github.com/callstackincubator/simlock/pull/869
* test(console): stop the Overview's route stubs before the fleet shuts down by @V3RON in https://github.com/callstackincubator/simlock/pull/867
* ci: run console e2e only in Chromium by @V3RON in https://github.com/callstackincubator/simlock/pull/880
* test: wait for Console semantic state by @V3RON in https://github.com/callstackincubator/simlock/pull/882
* docs(adr): 0043 physical devices reach agent-device through a second daemon by @V3RON in https://github.com/callstackincubator/simlock/pull/872
* feat(agent-device): a worker runs a phone daemon beside the simulator daemon by @V3RON in https://github.com/callstackincubator/simlock/pull/876
* feat(agent-device): lease a physical phone through agent-device by @V3RON in https://github.com/callstackincubator/simlock/pull/879
* test: make E2E resource cleanup await process exit by @V3RON in https://github.com/callstackincubator/simlock/pull/884
* ci(release): plan, build on macOS, tag, publish through npm OIDC, release, deploy the site by @V3RON in https://github.com/callstackincubator/simlock/pull/833
* test: remove wall-clock waits from usage stats by @V3RON in https://github.com/callstackincubator/simlock/pull/883
* docs(adr): 0042 simlock updates itself through a frozen call and a detached updater by @V3RON in https://github.com/callstackincubator/simlock/pull/827
* feat(updater): the updater, its npm port and launcher port, and the install check by @V3RON in https://github.com/callstackincubator/simlock/pull/878
* feat(daemon): simlock update and POST /v1/update update one daemon after its leases end by @V3RON in https://github.com/callstackincubator/simlock/pull/885
* feat(daemon): every daemon knows the latest Simlock version, simlock status says when a newer one exists by @V3RON in https://github.com/callstackincubator/simlock/pull/887
* feat(gateway): update one worker from the gateway (#838) by @V3RON in https://github.com/callstackincubator/simlock/pull/888
* feat(ui): update a worker from the console (#839) by @V3RON in https://github.com/callstackincubator/simlock/pull/896
* fix(ios): stream a physical iPhone on CoreDevice 642 or later, not 642 only by @V3RON in https://github.com/callstackincubator/simlock/pull/902
* chore(agents): the test rules ride in the briefs, and the audit proves the spec instead of extending it by @V3RON in https://github.com/callstackincubator/simlock/pull/904
* fix(e2e): move the mouse off the menu so a new toast is not hovered (#900) by @V3RON in https://github.com/callstackincubator/simlock/pull/903
* test(daemon): relay timing test keeps every transfer sending until its windows close (#688) by @V3RON in https://github.com/callstackincubator/simlock/pull/901
* fix(gateway): a stale worker view no longer brings back a released lease (#898) by @V3RON in https://github.com/callstackincubator/simlock/pull/899
* fix(agent-device): an allocate with every capable worker drained answers NO_CAPACITY by @V3RON in https://github.com/callstackincubator/simlock/pull/935
* fix(e2e): the drain test answers the Fleet page without the host's load (#886) by @V3RON in https://github.com/callstackincubator/simlock/pull/938
* docs(adr): 0044 the console reads what its page shows, and events mark it stale (#905) by @V3RON in https://github.com/callstackincubator/simlock/pull/907
* feat(http): unchanged JSON answers under /v1 are 304 with an ETag by @V3RON in https://github.com/callstackincubator/simlock/pull/920
* feat(gateway): read one lease directly, name the worker's lease id (#913) by @V3RON in https://github.com/callstackincubator/simlock/pull/922
* feat(ui): the console reads per page and marks data stale from events by @V3RON in https://github.com/callstackincubator/simlock/pull/926
* feat(inbox): the daemon says what needs the operator: GET /v1/inbox by @V3RON in https://github.com/callstackincubator/simlock/pull/937
* feat(ui): the console sends ETags back and patches lease renewals in place by @V3RON in https://github.com/callstackincubator/simlock/pull/927
* feat(ui): one shared recent-events list per console tab by @V3RON in https://github.com/callstackincubator/simlock/pull/939
* test(console): an idle console on a 50-worker fleet stays under 40 requests a minute (#918) by @V3RON in https://github.com/callstackincubator/simlock/pull/940
* fix(ports): a worker redials a gateway that vanished without closing the uplink by @V3RON in https://github.com/callstackincubator/simlock/pull/942
* docs(adr): 0045 a device's screen streams to operators, not a lease's (#906) by @V3RON in https://github.com/callstackincubator/simlock/pull/908
* feat(stream): stream any running device by worker and device id by @V3RON in https://github.com/callstackincubator/simlock/pull/923
* fix(ui): console layout fixes from the 2026-10-23 review by @V3RON in https://github.com/callstackincubator/simlock/pull/924
* feat(ui): watch a device's screen from the device drawer by @V3RON in https://github.com/callstackincubator/simlock/pull/928
* feat(history): the worker's Events tab scrolls back through its history by @V3RON in https://github.com/callstackincubator/simlock/pull/943
* fix(http): an Android lease over HTTP names its adb serial as address by @V3RON in https://github.com/callstackincubator/simlock/pull/953
* feat(cli): simlock instructions prints the rules an agent must follow by @V3RON in https://github.com/callstackincubator/simlock/pull/960
* feat(cli): simlock setup installs the Simlock skill into Claude Code and Codex by @V3RON in https://github.com/callstackincubator/simlock/pull/969
* docs(adr): 0046 a standalone worker serves agent-device by default with a private profile by @V3RON in https://github.com/callstackincubator/simlock/pull/954
* feat(modules): a standalone worker writes a private agent-device profile for local agents by @V3RON in https://github.com/callstackincubator/simlock/pull/963
* feat(core): a standalone worker serves agent-device on localhost by default by @V3RON in https://github.com/callstackincubator/simlock/pull/967
* fix(e2e): keyboard console tests wait for the sign-in form before tabbing by @V3RON in https://github.com/callstackincubator/simlock/pull/936
* docs(adr): 0047 device.exec fills in the lease's device, and refuses another (#951) by @V3RON in https://github.com/callstackincubator/simlock/pull/955
* feat(drivers): device.exec fills in the lease's device and refuses another by @V3RON in https://github.com/callstackincubator/simlock/pull/972
* feat(mcp): run_on_device runs a command on the session's lease by @V3RON in https://github.com/callstackincubator/simlock/pull/974
* feat(leasing): lease.maxPerRequester per platform by @V3RON in https://github.com/callstackincubator/simlock/pull/975
* fix(android): quote a 4 s boot for a device with a matching clean baseline by @V3RON in https://github.com/callstackincubator/simlock/pull/978
* fix(capacity): a shut-down device holds no RAM budget by @V3RON in https://github.com/callstackincubator/simlock/pull/979
* docs(agent-device): parallel agents need their own session by @V3RON in https://github.com/callstackincubator/simlock/pull/980
* fix(e2e): a daemon start that exits 0 but never listened fails with its log tail by @V3RON in https://github.com/callstackincubator/simlock/pull/982
* fix(agent-device): sharding names a leased device by agent-device's device list name by @V3RON in https://github.com/callstackincubator/simlock/pull/986
* fix(daemon): log the Android driver's diagnostics by @V3RON in https://github.com/callstackincubator/simlock/pull/987
* test(agent-device): an over-limit download never delivers more than 2 GiB by @V3RON in https://github.com/callstackincubator/simlock/pull/988
* docs(gateway): a starting worker's leases are hidden from their owner by @V3RON in https://github.com/callstackincubator/simlock/pull/989
* fix(daemon): daemon start fails when the HTTP listener cannot bind by @V3RON in https://github.com/callstackincubator/simlock/pull/990
* fix(gateway): an expired lease on a disconnected worker no longer blocks its requester by @V3RON in https://github.com/callstackincubator/simlock/pull/992
* fix(daemon): a stop waits for the cleanup run in flight (#985) by @V3RON in https://github.com/callstackincubator/simlock/pull/999
* docs(website): --lease waits for a starting worker (#991) by @V3RON in https://github.com/callstackincubator/simlock/pull/1002
* chore(agents): process review 2026-10-25: turbo, bug:new triage, feature auto-close, orchestrator scripts, tool-guard waiting rules by @V3RON in https://github.com/callstackincubator/simlock/pull/993
* chore(checks): the test lint and nine repo tests hold the rules agents did not read, and fix the drift they found by @V3RON in https://github.com/callstackincubator/simlock/pull/994
* chore(checks): guards and PR checks make the delivery rules mechanical by @V3RON in https://github.com/callstackincubator/simlock/pull/995
* chore(checks): the spec lint runs before the checker, and a public-surface change needs its page by @V3RON in https://github.com/callstackincubator/simlock/pull/996
* build(deps): Fallow 3.35 with an honest CI gate by @V3RON in https://github.com/callstackincubator/simlock/pull/997
* fix(daemon): a stop mid-startup refuses parked requests (#1001) by @V3RON in https://github.com/callstackincubator/simlock/pull/1003
* fix(daemon): a stop waits for health ticks and recoveries in flight by @V3RON in https://github.com/callstackincubator/simlock/pull/1004
* fix(e2e): the keyboard-scroll test notes the row in view after the end row moves it by @V3RON in https://github.com/callstackincubator/simlock/pull/1007
* fix(e2e): the Events tab test reads every /v1/events body before the page closes by @V3RON in https://github.com/callstackincubator/simlock/pull/1008
* chore(comments): delete comments that say what, not why, since 4429038 by @V3RON in https://github.com/callstackincubator/simlock/pull/1011
* docs(adr): 0048 an iOS worker may keep its simulators in Xcode's device set by @V3RON in https://github.com/callstackincubator/simlock/pull/964
* feat(drivers): iOS simulators can live in Xcode's device set (drivers.ios.deviceSet) by @V3RON in https://github.com/callstackincubator/simlock/pull/976
* chore(ci): keep the release token out of the push URL; website install without scripts by @V3RON in https://github.com/callstackincubator/simlock/pull/889
* chore(deps): update ws, hono and the MCP SDK past their advisories; Dependabot for npm by @V3RON in https://github.com/callstackincubator/simlock/pull/890
* fix(daemon): exec children get a minimal environment; docs say what an agent token can do by @V3RON in https://github.com/callstackincubator/simlock/pull/891
* fix(daemon): the data directory is created owner-only by @V3RON in https://github.com/callstackincubator/simlock/pull/892
* fix(daemon): status.get shows an agent only its own leases and queue entries by @V3RON in https://github.com/callstackincubator/simlock/pull/893
* fix(contract): an exact osVersion is bounded like a component version by @V3RON in https://github.com/callstackincubator/simlock/pull/895
* feat(gateway): a join token is pinned to the first worker that uses it by @V3RON in https://github.com/callstackincubator/simlock/pull/894
* chore(comments): delete comments that say what, not why, in src/contract by @V3RON in https://github.com/callstackincubator/simlock/pull/1032
* chore(comments): delete comments that say what, not why, since 1f42ae4 by @V3RON in https://github.com/callstackincubator/simlock/pull/1033
* docs(adr): 0049, a lease holder watches and drives its device's screen (#1013) by @V3RON in https://github.com/callstackincubator/simlock/pull/1014
* feat(stream): a lease holder watches its own lease's screen by @V3RON in https://github.com/callstackincubator/simlock/pull/1025
* feat(gateway): a gateway module can hold a two-way byte channel to a worker module by @V3RON in https://github.com/callstackincubator/simlock/pull/1026
* feat(input): a lease's input socket by @V3RON in https://github.com/callstackincubator/simlock/pull/1034
* feat(input): Android input through scrcpy's control channel by @V3RON in https://github.com/callstackincubator/simlock/pull/1036
* feat(input): iOS simulator input through the HID injector by @V3RON in https://github.com/callstackincubator/simlock/pull/1037
* fix(gateway): drop agent-device instance pins when relaying by @V3RON in https://github.com/callstackincubator/simlock/pull/1045
* feat(warm-pool): configured targets come first, and warmPool.learn turns learning off by @V3RON in https://github.com/callstackincubator/simlock/pull/1043
* feat(warm-pool): simlock warm forget forgets a learned kind by @alcpereira in https://github.com/callstackincubator/simlock/pull/1040
* chore(comments): delete comments that say what, not why, since 65df1b6 by @V3RON in https://github.com/callstackincubator/simlock/pull/1038
* chore(deps): bump @readme/openapi-parser from 9.1.0 to 10.0.0 by @dependabot[bot] in https://github.com/callstackincubator/simlock/pull/1023
* feat(cli): simlock --version prints the installed version by @V3RON in https://github.com/callstackincubator/simlock/pull/1059
* feat(cli): simlock setup runs the doctor checks and reports the machine by @V3RON in https://github.com/callstackincubator/simlock/pull/1062
* docs(website): one install recipe, MCP by scope, for-agents box by @V3RON in https://github.com/callstackincubator/simlock/pull/1065
* ci(release): build the package on the xcode-27 image by @V3RON in https://github.com/callstackincubator/simlock/pull/1072

### New Contributors
* @alcpereira made their first contribution in https://github.com/callstackincubator/simlock/pull/167

**Full Changelog**: https://github.com/callstackincubator/simlock/compare/v0.2.0...v0.4.0

## [0.3.0](https://github.com/callstackincubator/simlock/compare/v0.2.0...v0.3.0) (2026-09-03)

ADR 0003 (`docs/adr/0003-one-typed-daemon-contract-behind-every-frontend.md`):
every daemon operation is now declared once, as a typed contract
(`src/contract/`), served by one shared dispatcher to all four frontends —
the CLI, the stdio MCP server, the HTTP gateway, and a new programmatic
client (`simlock/client`, `simlock/admin`, see `docs/CLIENT.md`). This is a
breaking release for every frontend's wire vocabulary; see below.

### ⚠ BREAKING CHANGES

- **CLI:** `--json` output and stderr event lines (`lease`, `daemon`, and
  progress/push lines) are now the contract's own values, serialized as-is.
  The old snake_case renderings (`expires_at_ms`, `estimated_boot_ms`,
  `eta_seconds`, …) are gone. Exit codes are unchanged; human-readable
  `status`/`catalog` formatting is unchanged.
- **MCP:** tool names are unchanged, but every tool's input/output schema is
  now derived from the contract instead of hand-declared. Two field changes
  need every caller updated:
  - `lease_simulator`'s `timeout_seconds` is now `timeoutMs`. The input
    schema is `.strict()`, so a caller still sending the old key gets a
    hard `BAD_REQUEST`, not a silent failure. The real hazard is a caller
    that renames the field but not its value: `{"timeoutMs": 30}` meaning
    "30 seconds" is valid input, and times out ~1000× _sooner_ than
    intended (`QUEUE_TIMEOUT`, exit 10) rather than later — update the
    field name **and** multiply the value by 1000.
  - The top-level `slim: boolean` on a grant is gone; it is now
    `device.featureProfile` (`"full" | "reduced" | undefined`). A caller
    still checking `result.slim === true` silently never sees a
    feature-loss signal again.

  See `docs/CLI.md#simlock-mcp` for the full callout.

- **Socket protocol:** moves to protocol 3 with no compatibility shim. A
  version-mismatched client fails `hello` with
  `PROTOCOL_VERSION_UNSUPPORTED` and never restarts the daemon — run
  `simlock daemon stop` once it's idle. `daemon.stop` is a frozen exception,
  accepted at any protocol version the daemon has ever spoken (still
  admin-role gated).
- **`lease.request`'s wire shape** drops the legacy `device`/`os` field
  aliases and the nested `request` wrapper the pre-0.3.0 daemon accepted;
  an old client sending them now gets `BAD_REQUEST` instead of those keys
  silently vanishing.
- **HTTP:** `GET /v1/leases/:id` and `GET /v1/leases/:id/events` now return
  `404 UNKNOWN_LEASE` instead of `403 FORBIDDEN` for another requester's
  still-live lease — there is no dispatcher operation for a single-lease
  read to defer to, so both fall back to `lease.list`'s own filter, which
  does not distinguish "unknown" from "not yours" either. `POST
/v1/leases/:id/renew` and `DELETE /v1/leases/:id` dispatch
  `lease.renew`/`lease.release` directly instead and keep answering `403
FORBIDDEN` for the same case, matching the socket transport exactly — see
  `docs/HTTP-API.md#get-v1leasesid`.
- **`token create|list|revoke`** are now daemon operations (admin role) —
  the daemon is the sole owner of `tokens.json`. `config set` and
  `daemon logs` remain file operations.

### Bug Fixes

- **http:** `allowDownload` is now clamped through `config.downloads.policy`
  the same way the socket protocol always was — HTTP previously passed a
  client-supplied `allowDownload` through unclamped, so a `"never"` policy
  could be bypassed over HTTP even though the socket already blocked it.
- **http:** a request arriving before the daemon's startup convergence
  finishes now waits on the shared dispatcher's readiness gate instead of
  being refused — the HTTP gateway's listener starts at socket-claim time
  rather than only after convergence completes.
- **cli:** filter lease-lost pushes by this connection's own lease id, so a
  second CLI invocation sharing a principal (e.g. a detached lease from an
  earlier `--detach`) doesn't misreport a push for a lease this process
  never held.
- **contract:** restrict `lease.cancel` to the calling principal (only
  admin may cancel on another principal's behalf).
- **daemon:** require the admin role for `daemon.stop`.
- **http:** `GET /v1/lease-requests/{id}` and friends now answer `404
UNKNOWN_LEASE_REQUEST`, not `404 UNKNOWN_REQUEST` — the latter collided
  with the contract's own `UNKNOWN_REQUEST` (a 400 protocol error for an
  unrecognized operation name), so a client branching on `error.code` alone
  could not tell "no such request id" from "no such operation".

### Features

- **contract:** declare every daemon operation once — name, role, input/
  output zod schema, optional `authorize` hook — with public TypeScript
  types inferred from the schemas (`src/contract/`).
- **daemon:** move request handling into one transport-independent
  dispatcher (`src/daemon/dispatcher.ts`) serving both the unix socket and,
  in-process, the HTTP gateway.
- **daemon:** negotiate protocol versions as `{min, max}` ranges instead of
  an exact match.
- **daemon:** resolve `hello`'s admin credential — an operator token or the
  daemon's per-start `admin.token` secret — before any other request on the
  connection runs; wire the admin handshake and route lease-scoped pushes to
  every live connection sharing a lease's owner, not just the holder.
- **core:** persist a lease's `ownerId`, distinct from `requesterId` (ADR
  0003 §4) — the session principal a lease was granted to, vs. the
  per-request attribution a connection may vary. `lease.released`/
  `lease.expired` now carry `ownerId` in their event payloads.
- **client:** add the typed daemon client core (`simlock-client`) and
  publish it as the `simlock/client` and `simlock/admin` package entry
  points — one connection, no reconnect, no retry, with `AbortSignal`-driven
  cancellation on `requestLease` (see `docs/CLIENT.md`).
- **cli, mcp:** move onto the typed client, deleting the hand-built request
  payloads and raw response parsers both frontends carried before.
- **http:** move HTTP onto the shared dispatcher, deleting its own copies
  of status assembly, decoration, error mapping, and ownership checks.

### Documentation

- record ADR 0003 (`docs/adr/0003-one-typed-daemon-contract-behind-every-frontend.md`).
- add `docs/CLIENT.md` for the new programmatic client; document the
  contract/dispatcher architecture and the cooperative-identity security
  model in `docs/ARCHITECTURE.md`; document the breaking changes above in
  `docs/CLI.md` and `docs/HTTP-API.md`; record true-cancellation-during-
  provisioning and the HTTP tracker/notice-buffer stateful leftovers in
  `docs/known-pitfalls.md`.

## [0.2.0] and earlier

Not tracked in this file — see `git log` for history before this changelog
was introduced.
