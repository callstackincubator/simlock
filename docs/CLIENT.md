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
`lease.maxTtlMs`), and a frontend that means to hold a device for a while
runs its own renew timer over it — the CLI and the MCP server both renew at
one third of the remaining TTL and release on exit, and that is ordinary
frontend code, not something this client does for you. There is no heartbeat
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

- **MCP** keeps a lazy reconnect, because its process outlives any single
  connection — the next tool call after a dead connection builds a brand new
  client (see `src/mcp/session.ts`, `src/mcp/connect.ts`).
- **The CLI** needs none — a CLI invocation's whole purpose ends with its
  connection.
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
