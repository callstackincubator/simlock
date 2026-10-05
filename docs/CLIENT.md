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
`getConfig`, `stopDaemon`, `replayEvents`/`subscribeEvents` (each event carries an `id`),
`usage`,
`createToken`/`listTokens`/`revokeToken`, `installComponent`, `removeComponent`). The split exists so
`simlock/client` doesn't even show admin methods in a caller's editor; the
daemon's own role check is what actually stops an agent-role session from
calling one — this is a discoverability choice, not the
enforcement mechanism.

Both are async factories that open one connection and complete the `hello`
handshake:

```ts
const client = await connectSimlock({
  endpoint: "/path/to/daemon.sock", // or omit + pass `connection` in tests
  principal: "agent-1",
});

const grant = await client.requestLease({ platform: "ios", model: "iPhone 17 Pro", mode: "slim" });
// grant: { device, lease, timing } — the contract's LeaseGrant, verbatim

await client.releaseLease({ leaseId: grant.lease.id });
await client.close();
```

`requestLease` names its device in one of three ways: `model`, an exact model;
`class`, one of `"phone"`, `"tablet"`, `"watch"`, `"tv"`, `"vision"`, `"auto"` or
`"desktop"`, in place of a model; or neither, which asks for a `"phone"`. Naming both is a
`BAD_REQUEST`. A request that names a class or nothing is granted an idle device
that fits before any device is created, and `grant.device.spec` names the model
you got:

```ts
await client.requestLease({ platform: "ios", class: "tablet" });
await client.requestLease({ platform: "android" }); // a phone
```

Through a gateway, a request that names no `model` is a `BAD_REQUEST` for now.

`requestLease` takes an optional `mode`, `"slim"` or `"full"`: the device
mode the lease asks for. Without it the lease gets the default mode of the
worker that serves it (`ios.defaultMode`, `full` unless configured). Any
other value, or a field `requestLease` does not know, is a `BAD_REQUEST`.

`grant.device.mode` is the device mode the granted device actually has:
`"slim"` when its driver reduced its feature set, `"full"` otherwise. `full`
is a guarantee and `slim` is best effort: a `"slim"` request on a runtime
that cannot be slimmed (an iOS runtime older than 18.5, or any Android
device) is granted `"full"`, and a `"full"` request is never granted
`"slim"`. A slim device lacks some system features — push notifications,
Spotlight, StoreKit sheets, universal links, system pickers — so check it
before treating such a failure as a bug. Every device in `getStatus()` and in
an admin's `list({ kind: "devices" })` carries the same `mode`.

On Android, `requestLease` also takes an optional `imageTag`: the system image
type to create the device from, such as `"google_apis_playstore"`, as
`getCatalog()` lists it under each image's `tag`. Without it Simlock picks the
image itself (`google_apis` for the host's ABI when installed). With it the
device comes from an installed image of that tag, and without `osVersion` from
the newest API level that has one. A request with `imageTag` never downloads:
when no image of that tag is installed for the API level it fails with
`RUNTIME_MISSING`, whatever `allowDownload` says. On iOS it is a
`BAD_REQUEST`, and so is a tag that is not 1 to 64 letters, digits, `_`, `.`
or `-`. Through a gateway, a request whose tag no worker lists for that API
level, an iOS one included, fails at once with `RUNTIME_MISSING`, with or
without `noWait`.

```ts
const grant = await client.requestLease({
  platform: "android",
  model: "Pixel 8",
  imageTag: "google_apis_playstore",
});
grant.device.spec.imageTag; // "google_apis_playstore"
```

`grant.device.spec.imageTag` is present on a device whose request named a
tag, in the grant, in `getStatus()` and in `list({ kind: "devices" })`, and
absent otherwise. A request reuses only an idle device created for the same
tag, or for no tag when it names none.

`requestLease` takes an optional `onProgress` in its second argument, called
with the request's `LeaseProgress` as it moves along:

```ts
type LeaseProgress =
  | { stage: "queued"; queuePosition: number }
  | { stage: "downloading"; component: string; waiting: boolean; percent?: number }
  | { stage: "provisioning"; etaMs: number }
  | { stage: "booting"; etaMs: number }
  | { stage: "reclaiming"; etaMs: number };
```

`downloading` is a request with `allowDownload: true` waiting on the download
of a missing runtime, before any device work. `component` names what is
being downloaded, as the platform names it: an iOS version or an Android API
level, for example. `waiting` is `true` while another download on the same
platform runs ahead of this one, and `false` once this download runs.
`percent`, a whole number from 0 to 100, is there when the platform's
installer printed one. A request that joins a download already running hears
that download's latest progress at once. A request that needs no download
never hears this stage.

**Keeping the lease alive is yours to do.** Every lease is TTL-bound: it expires at
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

**Getting an answer back after a disconnect.** Pass `idempotencyKey` to
make a request repeatable:

```ts
const grant = await client.requestLease({
  platform: "ios",
  model: "iPhone 17 Pro",
  idempotencyKey: "build-4812",
});
```

Simlock stores the request under that key and your requester id before it
queues it. If your connection drops, or the daemon restarts, before you get
the answer, connect again and send the same request with the same key. While
the request is still waiting you join that wait, and once it has a result
you get that result. Either way it never grants you a second lease. A result
is never worked out again: a request that failed stays failed under its key,
so use a new key to try again. Keys last for `lease.requestRetentionMs` after
the request finishes. The same key with a different device is
`IDEMPOTENCY_CONFLICT`. Keys belong to a requester id, and a repeat must come
from the same connection principal that sent the request: the same key and
requester id from a different principal is `FORBIDDEN`. A request still waiting when the daemon restarts
ends as failed (`INTERNAL`, with a message saying so).

`connectSimlockAdmin` additionally accepts `credential` — an operator token
or the daemon's per-start `admin.token` secret (see
[CLI.md](CLI.md#admin-credential-resolution) for how the CLI resolves one). A missing or wrong
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

## Running a command on the leased device: `exec`

Two methods reach the device a lease names, and which one you want depends on
one thing: whether this process is on the machine that owns it.

```ts
// Same machine: resolve the scoped command and run it yourself.
const command = await client.resolvePassthrough({ tool: "adb", args: ["shell", "getprop"] });
// -> { command: "/sdk/adb", args: ["-P", "5038", "shell", "getprop"], env: { ... } }

// Somewhere else: run it on the daemon's machine and stream the output back.
const { exitCode } = await client.exec(
  { leaseId: grant.lease.id, tool: "adb", args: ["shell", "getprop"] },
  { onOutput: ({ stream, chunk }) => process[stream].write(chunk) },
);
```

`resolvePassthrough` only resolves: it hands back the command line the
driver builds (the scoping flags for its own device root, `simctl --set` or
`adb -P`), and running it is yours to do — which only works if the paths and
the adb port it names exist where you are.

`exec` runs it. The daemon resolves the same command through the same
driver — the same scoping, and the same refusal list, so a verb the driver
will not proxy comes back as `PASSTHROUGH_REFUSED` from either method, and a
`tool` no driver on that machine wraps as `UNKNOWN_PASSTHROUGH_TOOL` — spawns
it on its own machine, and streams the output to `onOutput` as it arrives.
Each call gets `{ stream: "stdout" | "stderr", chunk }`; `chunk` is whatever
the command wrote, decoded as UTF-8 and forwarded unsplit, so a caller that
wants lines assembles them itself. Nothing is buffered daemon-side and there is
no size cap. The promise resolves with the command's own `exitCode`.

`leaseId` is an ownership proof and nothing more: the *device* is named by the
command's own arguments, which the daemon does not parse. An agent-role client
is authorized against the lease it owns, exactly as for `renewLease` — a lease
it does not own is `FORBIDDEN`, and an id that names no lease is
`UNKNOWN_LEASE`.

An **admin-role** client (`simlock/admin` with a credential) does *not* get the
usual admin bypass here. It passes `requesterId` — the agent it is running the
command for — and it must match the requester the lease was granted to, or the
call is `FORBIDDEN`. Omitting it is not a bypass either: the *daemon* fills it
in with the connection's own principal and then applies the same comparison,
so an admin connection that names nobody reaches only the leases granted to
itself. The field exists for a proxy holding one admin connection on behalf of
many agents; an operator reaching another agent's device names that agent
deliberately rather than getting there implicitly. An agent-role client has no
say in it at all — its `requesterId` is ignored, and it is authorized against
the lease it owns.

Three limits worth knowing:

- **No pseudo-terminal.** Line-oriented commands work; full-screen and
  interactive ones do not, and a bare `adb shell` -- which is exactly the
  interactive shell -- is refused with `PASSTHROUGH_REFUSED` rather than left
  to hang until the timeout.
- **`stdin` is one shot.** The optional `stdin` string is written to the
  command once and the pipe is then closed — not a channel you can write to
  over time.
- **`exec.timeoutMs`** (ten minutes by default) kills a command that outruns
  it, and the call rejects with `EXEC_TIMEOUT` rather than reporting the exit
  code the kill produced. Losing the connection does not kill the command;
  it only ends the output you were receiving.

Paths in `args` resolve on the daemon's filesystem, not yours. Getting an
`.app` or an `.apk` there is out of scope for now.

## Picking a device: `getCatalog`

`getCatalog({ platform? })` returns what can be leased, per platform:

```ts
const { platforms } = await client.getCatalog({ platform: "ios" });
// [{ platform: "ios",
//    models: ["iPhone 16", "iPhone XS"],
//    runtimes: ["18.4", "26.0"],
//    defaultRuntime: "26.0",
//    modelRuntimes: { "iPhone 16": ["18.4", "26.0"], "iPhone XS": ["18.4"] },
//    modelAliases: {},
//    modelClasses: { "iPhone 16": "phone", "iPhone XS": "phone" },
//    classDefaults: { phone: "iPhone 16" } }]
```

- `models` and `runtimes` are what is installed. A model and a runtime that
  are each listed do not always pair: on iOS a newer runtime can drop an
  older model.
- `modelRuntimes` has an entry for every model: the installed runtimes it
  pairs with. Any pair listed there resolves in `requestLease`. An empty
  list means nothing installed pairs with that model.
- `modelAliases` maps a model to the other names `requestLease` accepts for
  it, in any letter case. Only models with another name appear. On Android
  a built-in profile's AVD id is one (`{ "Pixel 8": ["pixel_8"] }`); iOS
  has none.
- `modelClasses` maps a model to its class, one of `"phone"`, `"tablet"`,
  `"watch"`, `"tv"`, `"vision"`, `"auto"` or `"desktop"`, when its tooling
  reports one. A model with no entry is still listed and leasable by name.
- `classDefaults` maps a class to the model Simlock would create for it on
  this machine: the first name on the class's preference list that is listed,
  is of the class and pairs with an installed runtime. The list is the names
  in `ios.defaultModels.<class>` or `android.defaultModels.<class>`, then
  Simlock's own. A class in which no listed name counts has no entry.
- `images` is on Android entries only: every installed system image as
  `{ runtime, tag, abi }`, where `runtime` is a value from `runtimes`. An
  image whose ABI the host cannot run natively is listed too.
- `customModels` lists the models that exist because of something on that
  machine rather than the platform's tools: on Android, a profile made with
  Android Studio's device manager and read from `devices.xml`. A built-in
  profile with the same name wins, and that model is not custom. The field
  is absent when there are none, and iOS never has it.
- `defaultRuntime` is the newest installed runtime, and is absent when none
  is installed.
- The catalog lists only what is installed. It never lists a runtime the
  daemon could download, whatever the download policy.
- On a daemon, a platform whose tools cannot be read is left out, unless
  `platform` names it: then `getCatalog` rejects with that error.

Against a gateway the catalog is the union of the connected workers'. A
model is paired with a runtime when at least one worker pairs them, and
`modelWorkers` and `runtimeWorkers` say which workers have each model and
runtime. The gateway sends a request only to a worker that pairs the model
with the runtime. `modelAliases` and `images` are the unions of each
worker's own, and so is `modelClasses`: when two workers class a model
differently, the worker with the smallest id wins. A class has a `classDefaults`
entry only when every connected worker reports the same model for it. A model is in `customModels` when any worker that lists it
marks it custom; each worker's own list is in its catalog on
`listWorkers()` from the admin client. A model may be asked for by any name a worker lists for it, in
any letter case, and the gateway sends that worker its own name for it.
`allowDownload` has no effect through a gateway: only installed runtimes
count.

## Installing a runtime: `installComponent`

`installComponent({ platform, version }, { onProgress? })` on the admin
client installs one iOS simulator runtime or Android system image, with no
lease — the call behind `simlock component install`:

```ts
const result = await admin.installComponent(
  { platform: "android", version: "35" },
  { onProgress: (progress) => console.error(progress) },
);
// onProgress: { stage: "waiting" }, then { stage: "downloading", fraction: 0.41 }
// result: { platform: "android", component: "35", outcome: "installed", version: "35" }
```

- `version` is the string `getCatalog` lists under `runtimes` once the
  component is installed: 1 to 64 characters, no whitespace or control
  character and no leading `-`, or the call rejects with `BAD_REQUEST`
  before anything is sent.
- `outcome` is `installed`, or `already-installed` when it was already
  there. `component` echoes the version asked for; `version` is the one
  installed. The catalog lists it at once.
- `onProgress` hears `waiting` while another download on the platform runs
  first, then `downloading`, with `fraction` from 0 to 1, at most three
  decimals, when the platform's installer reports one. An install that
  ends `installed` reports 1 before the call resolves.
- The call is the consent to download. Under `downloads.policy: "never"` it
  rejects with `DOWNLOADS_DISABLED`. Other rejections: `FORBIDDEN` for an
  agent session, `NO_DRIVER`, `INSUFFICIENT_DISK_SPACE`,
  `LICENSE_NOT_ACCEPTED`, `DOWNLOAD_TIMEOUT` once `downloads.timeoutMs`,
  waiting included, runs out, and `UNSUPPORTED_IN_GATEWAY_MODE` from a
  gateway, which installs only on workers it is told to (below).
- Concurrent calls, and lease requests with `allowDownload`, for the same
  component share one download, and each gets its result. A dropped
  connection does not stop the download; calling again joins it.

### On a gateway's workers: `installComponentOnWorkers`

`installComponentOnWorkers({ platform, version, workers }, { onProgress? })`
asks a gateway to install a component on its workers — the call behind
`simlock component install --worker`/`--all-workers`. `workers` is `"all"`
or a list of 1 to 64 distinct worker ids from `listWorkers()`.

```ts
const { results } = await admin.installComponentOnWorkers(
  { platform: "android", version: "35", workers: "all" },
  { onProgress: (progress) => console.error(progress) },
);
// onProgress: { stage: "downloading", fraction: 0.41, workerId: "3f81a2c4" }
// results: [
//   { workerId: "3f81a2c4", label: "mac-studio-2", outcome: "installed", version: "35" },
//   { workerId: "9b07de11", outcome: "refused", error: { code: "DOWNLOADS_DISABLED", message: "..." } },
// ]
```

- Every targeted worker is asked at the same time and installs the
  component under its own `downloads.policy`, disk check and
  `downloads.timeoutMs`. A drained worker is asked too.
- `results` has one entry per worker, in ascending worker id. `outcome` is
  `installed` or `already-installed` (with `version`), `refused` (the
  worker's policy is `"never"`), `failed` (the worker's own error code),
  `skipped` (`"all"` only: the worker could not be asked), or `unknown` (its
  connection dropped, or it did not answer within its own
  `downloads.timeoutMs` plus one minute; the install carries on). Every
  outcome but the first two carries `error: { code, message }`. The call
  resolves either way; read the outcomes.
- It rejects before any worker is asked with `UNKNOWN_WORKER` for an id the
  gateway does not know, `WORKER_UNREACHABLE` for a named worker it cannot
  ask, `FORBIDDEN` for an agent session, and `UNSUPPORTED_IN_WORKER_MODE`
  from a single host. Use `installComponent` there instead.
- A worker's new component is in the gateway's `getCatalog()` by the time
  the call resolves, unless the gateway could not read that worker's
  catalog just then; its next read brings it in. Nothing is retried or kept
  for a worker that was away.

## What is installed: `listComponents`

`listComponents({ platform? })`, on either client, lists every iOS
simulator runtime and Android system image installed on the daemon's
machine, whoever installed it — the call behind `simlock component list`:

```ts
const { components } = await client.listComponents({ platform: "android" });
// [{ platform: "android", version: "35", variant: "google_apis/arm64-v8a",
//    sizeBytes: 4201234567, installedBySimlock: true, installedAt: 1790864071200,
//    devices: 2, foreignDevices: 0 }]
```

- Entries are ordered by platform, then version, then variant. Without
  `platform`, both platforms are listed; a platform whose tools cannot
  answer is left out.
- `version` is the string `getCatalog` lists under `runtimes`. `variant`
  tells two components of one version apart: an iOS runtime's build, an
  Android image's tag and ABI. `sizeBytes` is absent when it cannot be read.
- `installedBySimlock` is `true` only for a component Simlock installed that
  is still the same one on disk; `installedAt` is when it did.
- `devices` counts Simlock's own devices of this platform and version that
  have not been deleted; two variants of one version show the same count.
  `foreignDevices` counts the devices outside Simlock that use the
  component: simulators in Xcode's default device set that have been booted
  at least once, and every AVD in the user's own AVD home. The simulators
  macOS creates by itself for each runtime it installs do not count until
  someone boots one.
- A gateway rejects it with `UNSUPPORTED_IN_GATEWAY_MODE`.

## Removing a runtime: `removeComponent`

`removeComponent({ platform, version, dryRun? })` on the admin client removes
one iOS simulator runtime or Android system image that Simlock installed —
the call behind `simlock component remove`. It does not ask for
confirmation; that is the caller's to do. `dryRun: true` runs every check a
removal runs and removes nothing.

```ts
const result = await admin.removeComponent({ platform: "ios", version: "26.4" });
// { platform: "ios", version: "26.4", outcome: "removed", sizeBytes: 9103456789 }
```

- `outcome` is `removed`, or `would-remove` for a dry run. `sizeBytes` is
  absent when it could not be read. The catalog stops listing the component
  at once.
- `residue`, when present, says what stayed behind and how to reclaim it.
  On iOS that can be the runtime's never-booted simulators in Xcode's
  default device set, now unavailable, which `xcrun simctl delete
  unavailable` clears, and the runtime's download in macOS's asset store,
  which Xcode's Settings, under Platforms, removes. Simlock deletes
  neither.
- It rejects, removing nothing, with `COMPONENT_NOT_OWNED` when Simlock did
  not install the component or it changed on disk since,
  `COMPONENT_IN_USE` when a device uses it, Simlock's or not (`details`
  carries `devices` and `foreignDevices`; a never-booted simulator in the
  default device set does not count), and `COMPONENT_BUSY` while an
  install or removal runs or waits on that platform. Other rejections:
  `FORBIDDEN` for an agent session, `NO_DRIVER`, and
  `UNSUPPORTED_IN_GATEWAY_MODE` from a gateway.

```ts
try {
  await admin.removeComponent({ platform: "ios", version: "26.4" });
} catch (error) {
  if (isSimlockError(error) && error.code === "COMPONENT_IN_USE") {
    console.error(`${error.details.devices} Simlock and ${error.details.foreignDevices} other devices use it`);
  }
}
```

## What machine answered: `getStatus().host`

`getStatus()` carries a `host` block beside `daemon`: the machine the daemon
runs on, worked out from the machine itself.

```ts
const { host } = await client.getStatus();
// { os: "macOS", osVersion: "15.5", arch: "arm64",
//   tools: [{ platform: "ios", name: "xcode", version: "16.4", build: "16F6" },
//           { platform: "android", name: "emulator", version: "35.4.9" }] }
```

- `tools` has one entry per platform tool the daemon's drivers use. A tool
  that is not installed is left out. Versions are read in the background, so
  `getStatus` never waits for them, and right after a daemon starts the list
  can be empty for a moment. They are read again once a minute has passed;
  if a read fails, the version from the last good read stays.
- A gateway reports its own machine with no tools, since it runs no
  drivers. Each worker's `host` is on its entry in `workers`, and on
  `listWorkers()` from the admin client.

## What is installing: `getStatus().installs`

`getStatus()` lists the component installs waiting or running on the
machine, whoever started them, oldest first and at most 16:

```ts
const { installs = [] } = await client.getStatus();
// [{ platform: "ios", component: "26.4", state: "downloading", since: 1790864071200, waiters: 2 }]
```

- `state` is `downloading` while the platform's installer runs, and `waiting`
  while the install is queued behind another one on the same platform or
  about to start. `since` is when the first request for it arrived; `waiters`
  is how many requests wait on it.
- An install leaves the list as soon as it ends, whether it succeeded,
  failed or timed out. The field is absent only from an older daemon.
- On a gateway the list covers the connected workers, each entry with its
  `workerId`, the 16 oldest across the fleet. Each worker's own list is on
  its entry in `workers` and on `listWorkers()`, beside its
  `downloads.timeoutMs`.

## What is waiting: `getStatus().waiting`

`getStatus()` lists the requests waiting for a device in the daemon's own
queue, oldest first:

```ts
const { waiting = [] } = await client.getStatus();
// [{ id: "req_7", requesterId: "agent-b", spec: { platform: "ios", model: "iPhone 16" },
//    createdAt: 1790864071200, stage: "queued", queuePosition: 1 }]
```

- `stage` is `queued` while the request holds a place in the queue, with
  `queuePosition` counting from 1, and `starting` while the daemon is
  working on it: placing it as it arrives, or finding, creating, booting or
  downloading a device for it. `spec` has only the fields the
  request named.
- A request leaves the list as soon as it is granted, fails or is cancelled.
  The field is absent only from an older daemon.
- On a gateway the list is the gateway's own queue. Each worker's own is on
  its entry in `workers` and on `listWorkers()`. The admin client's
  `list({ kind: "requests" })` lists both, each worker's entries with their
  `workerId`, the same list as `GET /v1/lease-requests`.

## How much was used: `usage`

`simlock/admin` only. `usage({ from, to })` returns the usage figures for a
window, the same answer `simlock stats --json` prints (see
[CLI.md](CLI.md), under `simlock stats`,
for what each figure counts). `from` and `to` are epoch milliseconds, `from`
before `to`, at most 90 days apart; the client refuses anything else before it
sends a frame.

```ts
const usage = await admin.usage({ from: Date.now() - 6 * 3_600_000, to: Date.now() });

usage.totals.requests;       // lease requests made in the window
usage.totals.wait.p95;       // milliseconds, or null when nothing waited
usage.workers[0]?.label;     // one entry for each worker; a worker lists itself
usage.series;                // one point per bucket, for a chart
```

The daemon computes the figures from its event history, so they cover only what
the history holds: `partial` is `true` and `coversFrom` says where they start when
it does not reach the start of the window. `window` in the answer is the window
asked for, widened to a whole number of `bucketMs`, and the series never has more
than 200 points. A window that ends before the oldest event the history holds
rejects with `HISTORY_NOT_KEPT`; its `details.oldestTs` is the oldest time the
history reaches. Against a gateway the totals are the fleet's and `workers` has
one entry for each worker.

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
per-connection lease state and releases nothing when a connection closes,
so the leases this client held are still granted, still
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
- **The CLI** needs none, and deliberately still does not have one.
  A `simlock lease` holder's lease outlives its connection, but the
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
own `lease.cancel` operation and waits for a real outcome, so
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
- **While a download or device work is already in flight** (downloading,
  provisioning, booting, reclaiming) — `lease.cancel` answers
  `not-cancellable` at this stage; the
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
doesn't end up holding the result. This is a known gap.

## Running a command on the leased device: `exec`

`exec` runs one `simctl` / `adb` command against a device you hold a lease
on, wherever that device actually is, and streams its output back as it
arrives:

```ts
const { exitCode } = await client.exec(
  { leaseId: grant.lease.id, tool: "simctl", args: ["install", "booted", "/tmp/MyApp.app"] },
  {
    onOutput: ({ stream, chunk }) => {
      (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
    },
  },
);
```

`onOutput` fires per chunk, with `stream: "stdout" | "stderr"`, in the order
the process produced it; the promise resolves once the command exits, with
the tool's own `exitCode` — a non-zero one is the command's answer, not a
thrown error. Output is streamed rather than buffered, so there is no size
cap and nothing accumulates in memory unless your handler accumulates it.
Omit `onOutput` and the output is simply dropped.

`exec` takes an optional `requesterId`, defaulting to the principal. An
agent-role connection does not need it: it is gated the ordinary way, its
principal against the lease's `ownerId`, exactly as
`renewLease` and `releaseLease` are. The field exists for the one session
that would otherwise bypass that check — the gateway's admin session on a
worker — and on this operation, unlike renew and release, **admin does not
bypass**: the worker compares the supplied `requesterId` to the lease's own
`requesterId` and answers `FORBIDDEN` on a mismatch. A host process proxying
several agents through an admin connection therefore passes the requester
that holds the lease:

```ts
await admin.exec(
  { leaseId, tool: "adb", args: ["shell", "getprop"], requesterId: "agent-7" },
  { onOutput },
);
```

Five things to know before building on it:

- **It is scoped to a lease the caller owns**, and it is the one
  lease-scoped operation where **`admin` does not bypass the ownership
  check**. `renewLease` and `releaseLease` let an admin connection act on any
  lease; `exec` does not, because a gateway's session on a worker is itself
  an admin session, and an admin bypass would leave one fleet agent's device
  protected only by the gateway's own index. Pass the right `requesterId` or
  get `FORBIDDEN`.
- **The command runs on the machine that owns the device**, against that
  machine's filesystem. A path in `args` (`simctl install <path>`, `adb
  install <apk>`) resolves *there*, so getting an artifact to a remote worker
  is out of band in v1.
- **`stdin` is one string, sent with the request** and then closed, and there
  is no pseudo-terminal. Line-oriented commands work; full-screen ones do
  not.
- **It is bounded by one timeout** (`exec.timeoutMs`, ten minutes by
  default, on the machine that runs the command). A command that outlives it
  is killed and the call rejects with `EXEC_TIMEOUT`.
- **The refusals are the daemon's, not a client's.** A verb that would change
  a device's lifecycle behind the registry's back rejects with
  `PASSTHROUGH_REFUSED`, and a `tool` outside `simctl`/`adb` with
  `UNKNOWN_PASSTHROUGH_TOOL` — the same list `simlock simctl` /
  `simlock adb` document. One refusal is particular to `exec`: a bare `adb
  shell` with no command is `PASSTHROUGH_REFUSED` ("needs a terminal") rather
  than a call that hangs until the timeout, since there is no pseudo-terminal
  for it to attach to.

## A gateway is just a daemon, as far as this client knows

`connectSimlock`/`connectSimlockAdmin` connect to a **gateway** — a daemon
that owns no devices and fronts a fleet of workers — exactly as they connect
to an ordinary worker daemon, over its unix socket, with the same methods,
the same types, and the same error codes. That is the point of the
gateway implementing the same contract: nothing in this module knows the
difference, and neither does code written against it.

**The one way to tell is `mode` in `getStatus()`'s daemon block**
(`"worker" | "gateway"`) — not each device's own `mode`, which is the device
mode (`"slim" | "full"`). Everything else you might reach for is a leaky
inference rather than an answer: a lease from a gateway carries an additive
`worker: { id, label }` block, but so might a future single-machine daemon's;
a lease id from a gateway names its worker, but ids are opaque and parsing
one is a bug waiting to happen.

Two behaviours worth knowing when the daemon on the other end is a gateway,
neither of which changes a call's shape:

- The one-lease-per-requester rule is **fleet-wide** —
  `REQUESTER_ALREADY_LEASED` can name a lease on a machine you have never
  heard of.
- A new error code, `WORKER_UNREACHABLE` (`kind: "transport"`), can come back
  from any lease-scoped call when the worker holding that lease has lost its
  uplink. Treat it as you would `DAEMON_CONNECTION_LOST` for that one lease:
  the lease is not necessarily gone, you simply cannot reach it right now,
  and it runs on the worker's TTL either way.

The fleet methods on the admin client work against a single host too, which
answers as a fleet of one:

- `listWorkers()` returns one entry, the host itself, with the same fields a
  gateway gives each of its workers. Its `id` is the id the host presents to
  a gateway, its `label` is `gateway.label`, and it is always `connected` and
  never `drained`.
- `drainWorker`, `undrainWorker`, `removeWorker` and
  `installComponentOnWorkers` reject with `UNSUPPORTED_IN_WORKER_MODE`, whose
  `details.operation` names the operation. It mirrors
  `UNSUPPORTED_IN_GATEWAY_MODE`: the operation exists, but not on this kind of
  daemon. Do not retry it.

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
- It does not restart the daemon on a protocol version mismatch. Leases
  survive a restart, but stopping a daemon out from under
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
