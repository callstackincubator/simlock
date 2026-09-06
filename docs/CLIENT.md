# Programmatic client (`simlock/client`, `simlock/admin`)

Part of the user manual: the typed daemon client a host process (for
example, agent-device) uses to lease devices over the daemon's unix socket
without spawning a `simlock` command. It is the same client the CLI and MCP
frontends are built on (`src/cli`, `src/mcp/session.ts`) — nothing about it
is second-class relative to the CLI.

Two entry points, split by import path rather than by a runtime flag:

```ts
import { connectSimlock } from "simlock/client"; // agent role
import { connectSimlockAdmin } from "simlock/admin"; // agent + admin role
```

`connectSimlockAdmin` returns a superset of `connectSimlock`'s client — every
agent-role method plus the admin-role ones (`list`, `runCleanup`, `runNuke`,
`getConfig`, `stopDaemon`, `replayEvents`/`subscribeEvents`,
`createToken`/`listTokens`/`revokeToken`). The split exists so
`simlock/client` doesn't even show admin methods in a caller's editor; the
daemon's own role check is what actually stops an agent-role session from
calling one (ADR 0003 §3) — this is a discoverability choice, not the
enforcement mechanism.

Both are async factories that open one connection and complete the `hello`
handshake:

```ts
const client = await connectSimlock({
  endpoint: "/path/to/daemon.sock", // or omit + pass `connection` in tests
  principal: "agent-1",
});

const grant = await client.requestLease({ platform: "ios", model: "iPhone 17 Pro" });
// grant: { device, lease, timing } — the contract's LeaseGrant, verbatim

await client.releaseLease({ leaseId: grant.lease.id });
await client.close();
```

**Keeping the lease alive is yours to do.** Every lease is TTL-bound ([ADR
0004](adr/0004-ttl-first-leases-on-every-transport.md)): it expires at
`grant.lease.ttlDeadline` unless a `renewLease` call lands first, and the
daemon does nothing on its own to keep it. `requestLease` takes an optional
`ttlMs` (`lease.defaultTtlMs` when omitted, `BAD_REQUEST` above
`lease.maxTtlMs`), and the lease stores that width: a `renewLease` carrying
no `ttlMs` re-applies the lease's own, rather than falling back to
`lease.defaultTtlMs`. A frontend that means to hold a device for a while runs
its own renew timer over that — the CLI and the MCP server both renew at one
third of the lease's TTL and release on exit, and that is ordinary frontend
code, not something this client does for you. There is no heartbeat
to declare and no connection-liveness mode to opt into: a renew arriving
before the deadline is the whole mechanism.

`connectSimlockAdmin` additionally accepts `credential` — an operator token
or the daemon's per-start `admin.token` secret (see
[ARCHITECTURE.md](ARCHITECTURE.md#security-model-cooperative-identity-not-a-hostile-process-boundary)
for what those are and how the CLI resolves one). A missing or wrong
credential fails the handshake with `ADMIN_AUTHENTICATION_FAILED` before any
other request is sent on that connection:

```ts
import { connectSimlockAdmin, isSimlockError } from "simlock/admin";

try {
  const admin = await connectSimlockAdmin({ endpoint: sockPath, credential: token });
} catch (error) {
  if (isSimlockError(error) && error.code === "ADMIN_AUTHENTICATION_FAILED") {
    // bad or missing credential
  }
}
```

Every exported type — `LeaseRequestInput`, `LeaseGrant`, `LeaseRecord`,
`DoctorReport`, `SimlockConfig`, error codes, and so on — is derived from
`src/contract`'s zod schemas, the same vocabulary the CLI's `--json` output
and MCP's tool schemas now share. Nothing core-private
(`DeviceRecord`/`LeaseRecord`-the-core-type) ever appears on this surface;
see `src/simlock-client/no-core-leak.test.ts`.

## Driving the leased device

Two methods reach the device a lease names, and which one you want depends on
one thing: whether this process is on the machine that owns it.

```ts
// Same machine: resolve the scoped command and run it yourself.
const command = await client.resolvePassthrough({ tool: "adb", args: ["shell", "getprop"] });
// -> { command: "/sdk/adb", args: ["-P", "5038", "shell", "getprop"], env: { ... } }

// Somewhere else: run it on the daemon's machine and stream the output back.
const { exitCode } = await client.execDevice(
  { leaseId: grant.lease.id, tool: "adb", args: ["shell", "getprop"] },
  { onOutput: ({ stream, chunk }) => process[stream].write(chunk) },
);
```

`resolvePassthrough` only resolves: it hands back the command line the
driver builds (the scoping flags for its own device root, `simctl --set` or
`adb -P`), and running it is yours to do — which only works if the paths and
the adb port it names exist where you are.

`execDevice` runs it. The daemon resolves the same command through the same
driver — the same scoping, and the same refusal list, so a verb the driver
will not proxy comes back as `PASSTHROUGH_REFUSED` from either method — spawns
it on its own machine, and streams the output to `onOutput` as it arrives.
Each call gets `{ stream: "stdout" | "stderr", chunk }`; `chunk` is whatever
the command wrote, decoded as UTF-8 and forwarded unsplit, so a caller that
wants lines assembles them itself. Nothing is buffered daemon-side and there is
no size cap. The promise resolves with the command's own `exitCode`.

`leaseId` is an ownership proof and nothing more: the *device* is named by the
command's own arguments, which the daemon does not parse. A lease this
client's principal does not own is `FORBIDDEN`; an id that names no lease is
`UNKNOWN_LEASE`.

Three limits worth knowing:

- **No pseudo-terminal.** Line-oriented commands work; full-screen and
  interactive ones (a bare `adb shell`) do not.
- **`stdin` is one shot.** The optional `stdin` string is written to the
  command once and the pipe is then closed — not a channel you can write to
  over time.
- **`exec.timeoutMs`** (ten minutes by default) kills a command that outruns
  it, and the call rejects with `EXEC_TIMEOUT` rather than reporting the exit
  code the kill produced. Losing the connection does not kill the command;
  it only ends the output you were receiving.

Paths in `args` resolve on the daemon's filesystem, not yours. Getting an
`.app` or an `.apk` there is out of scope for now.

## One connection, no reconnect, no retry

This is the one thing to internalize before building anything on top of this
client: **it owns exactly one connection and never reconnects or retries,
not even for reads.** When the connection dies — the daemon stops, crashes,
or the socket is killed out from under it — every in-flight call rejects
with `DAEMON_CONNECTION_LOST`, `onConnectionLost` fires, and the client is
done. There is no automatic retry loop hiding behind any method, including
`getStatus` or `getCatalog` — a shared retry policy is a trap the moment it
touches a mutation, so this module simply does not have one at all, for
anything.

**A dead connection is not a dead lease.** The daemon keeps no
per-connection lease state and releases nothing when a connection closes
(ADR 0004 §3), so the leases this client held are still granted, still
yours, and still counting down their TTL. What you have lost is the ability
to renew them and to receive their pushes — nothing more. Connect again and
call `renewLease` with the lease id and you have picked the lease straight
back up; do nothing and it expires at its deadline like any other. That is
why `onLeaseLost` no longer fires on connection loss: it reports a lease the
daemon actually ended (expiry, an operator release, an unrecoverable
device), and a dropped socket is not one.

Reconnect policy is deliberately a frontend's own concern, not something
this client can make a universal decision about:

- **MCP** reconnects, because its process outlives any single connection,
  on either of two triggers (see `src/mcp/session.ts`, `src/mcp/connect.ts`).
  A tool call after a dead connection builds a brand new client and may
  auto-launch a daemon that is not running. Its renew timer builds one too,
  so an idle session does not lose its lease waiting for a call that never
  comes — but that trigger only ever connects to a daemon that is already
  listening, never launches one, so an operator's `daemon stop` is not undone
  by an idle session.
- **The CLI** needs none, and deliberately still does not have one under
  ADR 0004. A `simlock lease` holder's lease outlives its connection, but the
  holder itself does not: it writes a `DAEMON_CONNECTION_LOST` line naming
  the lease and its deadline, exits `1`, and leaves the lease standing for
  another invocation to renew or for the TTL to end.
- **A host process** (agent-device) has its own supervisor and its own
  opinion about what "still needed" means across a daemon restart; this
  client does not guess on its behalf.

The payoff of never reconnecting automatically: "reconnecting never
implicitly acquires a device" is trivially true for a client that cannot
reconnect at all. If you need resilience across a dropped connection, build
it explicitly — call `connectSimlock`/`connectSimlockAdmin` again and decide
for yourself whether the lease you were holding is worth renewing — or
whether letting it expire is the better answer.

```ts
client.onConnectionLost((error) => {
  // Fires exactly once. Every in-flight call has already rejected
  // DAEMON_CONNECTION_LOST by the time this runs. Any lease this client
  // was holding is still alive on the daemon — decide whether to reconnect
  // and renew it, or to let its TTL run out.
});
```

## Abort semantics

`requestLease` takes an `AbortSignal` as part of its options. Aborting does
not simply drop the caller's interest client-side — it drives the daemon's
own `lease.cancel` operation (ADR 0003 §9) and waits for a real outcome, so
the caller is never left guessing whether a device is or isn't leased to it:

```ts
const controller = new AbortController();
const promise = client.requestLease(
  { platform: "ios", model: "iPhone 17 Pro" },
  { signal: controller.signal, onProgress: (p) => console.log(p) },
);
controller.abort();
await promise; // rejects with a CANCELLED SimlockError, in every case below
```

Four cases, by when the signal fires:

- **Before the request is even sent** — rejects `CANCELLED` immediately;
  nothing is sent to the daemon at all.
- **While the request is still queued** — sends `lease.cancel`, waits for
  the original request to actually reject, then surfaces `CANCELLED`
  regardless of what that rejection's own code/message was.
- **While device work is already in flight** (provisioning, booting,
  reclaiming) — `lease.cancel` answers `not-cancellable` at this stage; the
  client waits for the request's real outcome. If a grant still lands, it is
  released immediately (`releaseLease`, best-effort) so the caller never
  ends up holding a device it already told the client it didn't want, and
  `CANCELLED` is surfaced either way.
- **After the grant already resolved** — the abort is ignored; you have a
  device, and aborting an already-finished request is a no-op by design, not
  an implicit release.

**True cancellation during provisioning is out of scope for this release.**
The "device work already in flight" case above releases the grant
immediately once it lands rather than actually interrupting the in-flight
provision/boot/reclaim — the daemon keeps doing the work, the caller just
doesn't end up holding the result. This is recorded as a known gap in
[known-pitfalls.md](known-pitfalls.md).

## What this client does not do

- It does not start or stop the daemon. `connectSimlock`/`connectSimlockAdmin`
  only ever connect to an already-listening socket; auto-launch (what the
  CLI and MCP do on a missing daemon) is a frontend concern layered on top,
  not something this module provides. Build your own launch-then-retry
  policy around it if you need one — `src/mcp/connect.ts`'s
  `connectWithAutoLaunch` is a worked example, deliberately never launching
  on anything but "nothing is listening" (a version mismatch or a refused
  handshake means something answered, and launching there risks a second
  daemon instance or masking a real incompatibility).
- It does not restart the daemon on a protocol version mismatch — see
  [ARCHITECTURE.md](ARCHITECTURE.md) and [ADR
  0003](adr/0003-one-typed-daemon-contract-behind-every-frontend.md) §6 for
  the decision. ADR 0004 changed what a stop costs without changing the
  answer: leases now survive a restart, but stopping a daemon out from under
  its users still kills every queued lease request on the machine and leaves
  every lease it was serving burning TTL with nothing to renew against.
  `PROTOCOL_VERSION_UNSUPPORTED` names the running daemon's version; the fix
  is `simlock daemon stop` when it's idle, run by an operator or supervisor,
  not this client.
- It does not expose a role the daemon itself would reject — `simlock/admin`
  showing you `stopDaemon`/`runNuke`/etc. is a TypeScript-editor
  convenience, not the actual gate. The daemon's own role check is what
  actually stops an agent-credentialed connection from calling one; do not
  treat "the method exists on the type" as proof of authorization.
