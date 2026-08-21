# JS/TS API

> Status: **proposal**. Nothing here is implemented yet — this is the shape
> being proposed for review, written as the user manual it would become.

Pitlane's audience is agents and automations, and today they reach it two
ways: spawn the CLI and parse JSON lines, or speak MCP. A third audience is
already visible — Node test runners, CI scripts, custom orchestrators — and
for them both existing frontends are awkward. Shelling out re-serializes
typed data into JSON just to re-parse it, turns error codes into exit codes,
and, worst, cannot hold a lease: held mode's liveness *is* the socket the
holder process owns, so an in-process automation must keep a child process
alive and babysit its stdio to keep a device.

This proposes a third frontend — sibling to the CLI and the MCP server, over
the same daemon client and the same socket — packaged as `pitlane`'s main
export.

## The shape in one line

A **session-shaped client**, not a mirror of the CLI: one `Pitlane` client per
agent identity, a `Lease` handle whose scope is the lease's lifetime, and the
operator commands kept in a separate `admin` namespace.

```ts
import { createPitlane } from "pitlane";

const pitlane = createPitlane({ agentId: "web-e2e-shard-3" });

await using lease = await pitlane.lease(
  { device: "iPhone 17 Pro", os: "26.5", platform: "ios" },
  { onProgress: (p) => log(p.stage), timeoutMs: 120_000 },
);

await runTests({ udid: lease.udid });
// scope exit releases the lease — the same thing killing the CLI holder does
```

## How much of the CLI to expose

**All of the daemon protocol, tiered by audience — but shaped by what each
call means in-process, not by its flags.**

Exposing only leasing (the MCP server's choice) is right for MCP, where the
tool list is prompt context and every extra tool costs an agent's attention.
It is wrong here: an automation that can lease but cannot ask `status` or
stream `events` is forced back to spawning the CLI for the other half of its
job, and now it maintains two integrations. The daemon already answers every
one of these requests over the same socket; the cost of surfacing them is a
typed wrapper each.

The tiers are about *placement*, not availability:

| CLI | API | Tier |
|---|---|---|
| `lease` (held) | `pitlane.lease(spec, options?)` → `Lease` | lease |
| `lease --detach` | `pitlane.leaseDetached(spec, options?)` → `DetachedLease` | lease |
| `lease renew <id>` | `lease.renew(options?)` / `pitlane.renew(leaseId, options?)` | lease |
| `release <id>` | `lease.release()` / `pitlane.release(leaseId)` | lease |
| `catalog` | `pitlane.catalog(platform?)` | read |
| `status` | `pitlane.status()` | read |
| `list --devices` | `pitlane.devices()` | read |
| `list --leases` | `pitlane.leases()` | read |
| `list --rules` | `pitlane.cleanupRules()` | read |
| `config` | `pitlane.config()` | read |
| `events [--follow] [--since]` | `pitlane.events(options?)` → `AsyncIterable<PitlaneEvent>` | read |
| `config set <k> <v>` | `pitlane.admin.setConfig(key, value)` | admin |
| `cleanup [--dry-run] [--rule]` | `pitlane.admin.cleanup(options?)` | admin |
| `doctor [--fix]` | `pitlane.admin.doctor(options?)` | admin |
| `release --all` | `pitlane.admin.releaseAll()` | admin |
| `nuke [--delete-devices]` | `pitlane.admin.nuke(options?)` | admin |
| `daemon start\|stop\|status\|logs` | `pitlane.admin.daemon.{start,stop,status,logs}()` | admin |
| `mcp` | — (process-shaped; see below) | — |

`admin` exists so that autocomplete never puts `nuke()` one letter away from
`lease()`, and so the [safety rules](agent-rules/safety.md) have one module to
review rather than a flat surface where every method looks equally harmless.

### What deliberately does not cross over

- **Exit codes.** The API throws `PitlaneError` with the daemon's own `code`;
  the exit-code column in [CLI.md](CLI.md) stays a CLI concern.
- **`--json`.** Output is values.
- **`--yes`.** The confirmation prompt exists because a human typed
  `release --all` at a terminal. In-process there is no terminal to protect
  and no keystroke to guard against; calling `pitlane.admin.nuke()` in source
  code is itself the deliberate act. Adding `{ yes: true }` would be
  ceremony, not safety.
- **`--bind-pid` and the parent watch.** Both exist because the CLI holder is
  a *separate* process that can outlive its agent
  ([known-pitfalls.md](known-pitfalls.md)). The API's holder is the caller's
  own process; when it dies the socket dies with it. Nothing to bind.
- **`pitlane mcp`.** A long-lived stdio process, not a function call. If
  anyone wants to embed it, that ships as a separate `pitlane/mcp` export
  (`createMcpServer`, `startMcpStdio`), not a method on the client.

## The lease surface

### `createPitlane(options?)`

```ts
interface PitlaneOptions {
  /** Requester identity. Defaults to PITLANE_AGENT_ID, then `api:${pid}`. */
  readonly agentId?: string;
  /** Overrides PITLANE_HOME for this client. */
  readonly home?: string;
  /** Start the daemon if it isn't running. Default true. */
  readonly autoStartDaemon?: boolean;
  /** Test seams, matching the DI style the CLI and MCP frontends already use. */
  readonly clock?: Clock;
  readonly ipc?: IpcConnector;
  readonly launcher?: DaemonLauncher;
}
```

Cheap and lazy: constructing a client connects to nothing. The first call
that needs the daemon connects and auto-starts it, exactly as the CLI does.

### `pitlane.lease(spec, options?)`

```ts
interface DeviceSpec {
  readonly platform: "ios" | "android";
  readonly device: string;              // model, as in `catalog`
  readonly os?: string;                 // defaults to the newest installed runtime
}

interface LeaseOptions {
  readonly allowDownload?: boolean;     // never implicit; same rule as the CLI
  readonly noWait?: boolean;            // NO_CAPACITY instead of queueing
  readonly timeoutMs?: number;          // QUEUE_TIMEOUT on expiry
  readonly signal?: AbortSignal;        // CANCELLED, and gives the queue slot back
  readonly onProgress?: (progress: LeaseProgress) => void;
}

type LeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "provisioning" | "booting" | "reclaiming"; readonly etaMs: number };
```

Resolves once the device is ready — the same moment the CLI prints its one
stdout line. `onProgress` is scoped to the call and torn down when it
settles, so it never leaks across sequential leases.

### The `Lease` handle

```ts
interface Lease extends AsyncDisposable {
  readonly id: string;
  readonly deviceId: string;            // registry id — the one events use
  readonly udid: string | undefined;    // driver address: simctl UDID / adb serial
  readonly platform: "ios" | "android";
  readonly model: string;
  readonly osVersion: string;
  readonly expiresAt: number;           // slides as the heartbeat renews
  readonly timing: LeaseTiming;         // the grant's own ETAs

  release(): Promise<void>;
  renew(options?: { readonly ttlMs?: number }): Promise<void>;

  /** Ends without us asking: TTL backstop, operator release, unrecoverable device. */
  onLost(listener: (notice: LeaseLostNotice) => void): Unsubscribe;
  /** Device crashed and was rebooted under this same lease — see below. */
  onDeviceHealth(listener: (notice: DeviceHealthNotice) => void): Unsubscribe;
  /** The same fact as a promise, for `Promise.race([work, lease.lost])`. */
  readonly lost: Promise<LeaseLostNotice>;
}
```

`udid` is `string | undefined` for the same reason the grant payload's
`address` is: a device leased straight out of a pre-address `state.json`
without ever rebooting under this daemon has none.

Three lifetime rules the API inherits rather than invents, all already
enforced in the MCP session:

- **The connection is the lease.** If the socket dies, the lease is gone
  daemon-side; the client drops it and fires `onLost` with reason
  `daemon-connection-lost`. It never silently re-acquires a device.
- **Device health is not lease loss.** `onDeviceHealth` reports a crashed
  device rebooted under the same lease. The lease is untouched — but
  everything the automation had running *inside* the device is gone, and only
  the caller can rebuild it.
- **Release returns before the device is clean.** `release()` resolves when
  the lease record is gone; the purge runs behind it. A `status()` right
  after shows `reclaiming`, not `ready`.

For callers who cannot use `await using` (an older toolchain, a callback API):

```ts
await pitlane.withLease(spec, async (lease) => { /* ... */ });
```

### One lease per client

The daemon allows one active lease per requester, so a client instance is a
session rather than a stateless RPC stub. Parallel work uses parallel clients
with distinct identities — which is also the only way the constraint means
anything:

```ts
const leases = await Promise.all(
  specs.map((spec, index) =>
    createPitlane({ agentId: `shard-${index}` }).lease(spec),
  ),
);
```

A second `lease()` on a client that already holds one fails with
`REQUESTER_ALREADY_LEASED`, naming the lease to release first. The rule stays
daemon-authoritative; the API does not pre-empt it with a local check that
could disagree.

### Detached leases

For handoff across processes — a CI step that leases and a later step that
uses it — `leaseDetached()` returns a plain record instead of a handle, since
no object's lifetime can stand for the lease:

```ts
const { leaseId, udid } = await pitlane.leaseDetached(spec);
// ...later, elsewhere...
await pitlane.renew(leaseId, { ttlMs: 900_000 });
await pitlane.release(leaseId);
```

Detached leases are TTL-bound and have no heartbeat: renewing them by hand is
the only keep-alive, exactly as at the CLI.

## Errors

```ts
class PitlaneError extends Error {
  readonly code: PitlaneErrorCode;
}
function isPitlaneError(error: unknown, code?: PitlaneErrorCode): error is PitlaneError;
```

`code` is the daemon's own code, so [CLI.md](CLI.md)'s table stays the single
source of truth for what each one means. The ones an automation actually
branches on:

| Code | Meaning |
|---|---|
| `NO_CAPACITY` | `noWait` and no capacity |
| `QUEUE_TIMEOUT` | `timeoutMs` elapsed in the queue |
| `RUNTIME_MISSING` | runtime not installed, no `allowDownload` |
| `UNKNOWN_MODEL` / `NO_DRIVER` | unleasable spec / platform |
| `REQUESTER_ALREADY_LEASED` | this `agentId` already holds one |
| `UNKNOWN_LEASE` / `LEASE_EXPIRED` | the lease is no longer active |
| `DAEMON_UNAVAILABLE` / `DAEMON_CONNECTION_LOST` | could not reach / lost the daemon |
| `CANCELLED` | the call's `AbortSignal` fired |
| `CLIENT_CLOSED` | the client was closed underneath the call |

## Events

```ts
for await (const event of pitlane.events({ since: "1h", signal })) {
  if (event.event === "device.quarantined") alert(event);
}
```

`replay` then `subscribe`, surfaced as an async iterable — the JS shape for a
stream, and one `break` unsubscribes. Typed against the
[EVENTS.md](EVENTS.md) catalog.

One implementation constraint worth stating in the design rather than
discovering later: **the event stream must not run on the lease-holding
connection**, because ending the stream would close the socket that is the
lease. Long-lived reads get their own connection; one-shot reads and admin
calls may reuse the session connection, which already retries idempotent
requests once across a reconnect.

## Packaging

- `exports`: `"."` → the API, `"./mcp"` → the embeddable MCP server. The
  `pitlane` bin stays exactly as it is.
- `release-it` currently sets `npm.publish: false`; shipping this means
  flipping it and adding `files`.
- `await using` needs only `Symbol.asyncDispose`, present in Node ≥ 20;
  TypeScript downlevels the syntax, so the `engines: node >= 22` floor
  already covers it. `withLease` covers callers who cannot use it.

## Module layout

```
src/api/
  index.ts       createPitlane + public types
  client.ts      connection ownership, one-shot requests
  session.ts     lease state machine (extracted from src/mcp/session.ts)
  lease.ts       the Lease handle
  admin.ts       destructive + operator surface
  events.ts      replay + subscribe as an async iterable
  errors.ts      PitlaneError, isPitlaneError
  contracts.ts   camelCase mapping over daemon-client/contracts.ts
```

Per [architecture.md](agent-rules/architecture.md) this is a frontend: it
depends on `daemon-client` and `ports`, never on `core` or `drivers`, and the
core never learns a third frontend exists. It adds no daemon request types and
no events, so [EVENTS.md](EVENTS.md) is unchanged.

The interesting part is that most of it already exists. `McpSession` is this
API with snake_case field names bolted on: lazy reconnect, the one-lease
invariant, progress relay, lease-lost and device-health fan-out, the
serialized mutation queue. The proposal is to **extract it into
`src/api/session.ts` as a frontend-agnostic session and reduce
`src/mcp/session.ts` to the snake_case adapter over it** — one lease state
machine in the repo, not two that drift.

## Rollout

1. Extract the session out of `src/mcp/session.ts`. Pure refactor; the MCP
   tests are the proof.
2. `createPitlane` + `Lease` + `withLease`, unit-tested over
   `MemoryIpcTransport` and `FakeDaemonLauncher`.
3. Read tier, then `admin`.
4. `events()` as an async iterable, on its own connection.
5. Packaging, this doc demoted from proposal to manual, and an e2e suite
   against the existing `PITLANE_DRIVERS_MODULE` fake driver.

## Open questions

- Is `admin` the right fence, or should destructive calls live behind a
  separate `pitlane/admin` import so a test file cannot reach them at all?
- Should `createPitlane` accept `home`, or stay strictly `PITLANE_HOME`-driven
  like every other frontend?
- Ship `pitlane/testing` (memory ports + a scripted driver) so downstream
  suites can test against a fake daemon? Useful, but post-v1 unless someone
  asks.
