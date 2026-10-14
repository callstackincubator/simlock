# HTTP API reference

Part of the user manual: the network-facing control-plane API a remote agent
uses instead of the CLI/MCP frontends' unix socket. It is off by default
(`http.enabled: false` — see [CONFIGURATION.md](CONFIGURATION.md)) and, once
enabled, binds `127.0.0.1` unless configured otherwise. Reaching it from
another machine is the operator's own tunnel (Tailscale, cloudflared, a
reverse proxy) — Simlock does no TLS termination in v1, and `Authorization`
is required on every API route regardless of how it's reached, loopback
included (see [Authentication](#authentication) for the two exceptions).

This frontend calls the exact same in-process `Dispatcher` the unix socket
calls — not a second copy of role/ownership logic, and not a
loopback hop through the socket either. Every route that maps onto a daemon
operation gets the same input parsing, role check, `authorize`/ownership
hook, and startup-readiness parking a socket request gets, from that one
shared instance. This is also why a fix on the socket side (the download
policy, startup-readiness parking, error mapping) lands on HTTP for free —
see the two bug fixes called out below for what
this actually changed.

## Leases are TTL-bound, the same as everywhere else

A lease granted through this API is the same kind of lease `simlock lease`
gets on the unix socket: it carries a TTL, it
is kept alive by `POST /v1/leases/:id/renew` arriving before `expiresAt`, and
nothing else keeps it alive. There is no connection-liveness mode to be the
odd one out from — HTTP is stateless, and so is the lease model now, on every
transport. Closing a connection, dropping a tunnel, or losing the client
releases nothing; a lease that stops renewing expires at `expiresAt` and its
device is reclaimed normally.

That is the whole liveness story here, and it is worth stating plainly what
it costs: a client that vanishes without calling `DELETE /v1/leases/:id`
holds its device until `expiresAt` — at most the lease's own TTL after its
last renew: `lease.defaultTtlMs` unless the request asked for more, never
more than `lease.maxTtlMs`. Ask for a shorter `ttlMs` on the request if you
want a tighter bound.

Acquisition is an async resource, not a blocking call: `POST
/v1/lease-requests` returns as soon as the request exists (queued, or already
past that), and the client polls, long-polls, or streams its progress to a
terminal state. No route blocks on device work in flight.

## Authentication

Every route requires `Authorization: Bearer slk_<secret>` except two: `GET
/v1/healthz`, and the web console's own files, which the daemon serves at
every path outside `/v1` (see [CONSOLE.md](CONSOLE.md)). They hold no data;
the console reads everything it shows from the routes below, with the
operator's token. Missing or unrecognized tokens are `401 UNAUTHENTICATED`.

Tokens are minted and managed with `simlock token` (see [CLI.md](CLI.md)).
Since 0.3.0 `token.create|list|revoke` are daemon operations (admin role) and
the daemon is the only process that reads or writes `tokens.json`, so unlike
`config set` these do go through the daemon. Each token record
is
`{ id, role, label?, createdAt }`, hashed at rest in `~/.simlock/tokens.json`
(SHA-256; the plaintext secret is shown exactly once, at `create`, and never
persisted). The token id doubles as the requester identity over HTTP: unlike
the CLI's `--agent-id`/`SIMLOCK_AGENT_ID`, identity is never client-declared
here, so the one-lease-per-requester rule keys off which token authenticated
the request, not anything the request body says.

Three roles:

| Role | Can |
|---|---|
| `agent` | catalog, status, installed components, its own lease requests and leases, `exec` on its own lease |
| `operator` | everything `agent` can, plus every other requester's leases/devices, the token records, the worker routes, event replay/stream, and releasing any lease |
| `worker` | open an uplink at [`/v1/uplink`](#get-v1uplink-websocket-upgrade), and nothing else |

A valid token with the wrong role for a route is `403 FORBIDDEN`, not `401` —
distinct from an unrecognized token. Reaching another requester's own
resource (a lease/request an `agent` token didn't create) is the same `403`,
enforced per-resource rather than as a role gate.

The `worker` role is deliberately not a superset or a subset of the other
two, it is disjoint from both. `/v1/uplink` is the one route a join token
opens and the only route it opens: presented on any other `/v1` route it is
`403`, and an `agent` or `operator` token presented at `/v1/uplink` is `403`
just the same. Join tokens are minted with `simlock token create --role
worker` on the **gateway**, and tokens never cross machines — a gateway's
tokens are valid on that gateway and nowhere else.

**An `agent` token on a worker is a host-level credential, not a
device-level one.** `POST /v1/leases/{id}/exec` runs the command's *arguments*
on the worker's own filesystem with the daemon's own uid and environment
(`args` are never parsed beyond the driver's refusal list — see
[`POST /v1/leases/{id}/exec`](#post-v1leasesidexec)), so any lease at all is
enough to write or read files anywhere that uid can reach, not only the
leased device: `adb pull <device-path> <worker-path>` is a host-side
arbitrary file write, and there is no argument grammar this API parses that
would stop it. Size a worker's
trust boundary around the daemon's own uid, not around "one device," before
handing an `agent` token to something you would not otherwise let run on
that machine.

## Endpoints

All routes are under `/v1`, JSON bodies both ways, additive evolution only —
new fields, never removed or repurposed ones. That rule has been broken
twice, each time as a deliberate 0.x-only exception, and each break is
called out where it applies below:

- **`mode` is gone** from the lease record the operator routes serialize
  (`GET /v1/status`, `GET /v1/leases`), and **`lastRenewedAt` and the stored
  `ttlMs` are new on it** — there is one kind of lease now, and the fields
  that described the split went with it.
- **A `ttlMs` above `lease.maxTtlMs` is `400 BAD_REQUEST`** where it used to
  be accepted.
- **The `ttlMs` a lease reports is the lease's own width**, not a value the
  HTTP frontend remembered per request.
- **The lease's `slim` boolean is gone; it carries `mode` instead** —
  `"slim"` or `"full"`, the device mode of the granted device. Every device in
  `GET /v1/status` carries the same `mode`.
- **A physical device carries `driverDeviceId`** in `GET /v1/status`, its canonical
  ID, to every role: the ID `DELETE /v1/devices/{id}` takes. A simulator or
  emulator has none there.
- **A device carries `physical`**, `false` for a simulator or emulator and
  `true` for a real phone or tablet, in `GET /v1/status` and its `spec`. A
  physical device has a `class` (`phone` or `tablet`) and no `mode`, and so does
  a lease on one: its lease object has no `mode`.

Routes, status codes, and every other field are unchanged.

Gateway/worker fleet mode is purely additive on top of
that: the same routes answer identically whether the daemon behind them is a
worker or a **gateway** fronting a fleet of workers (except
`POST /v1/components/install`, `GET /v1/components`,
`DELETE /v1/components/{platform}/{version}`, `POST /v1/devices` and
`DELETE /v1/devices/{id}`, which only a worker serves; a
gateway answers `501 UNSUPPORTED_IN_GATEWAY_MODE`), and what it adds are new
routes (`/v1/uplink`, `/v1/workers*`, `POST /v1/leases/{id}/exec`), new
fields (`mode` on status, `workers[]`, `workerId`, `worker` on the lease),
and new error codes. Nothing existing changes shape, and a client that
ignores every one of them keeps working against a gateway unchanged.

### `GET /v1/healthz`

Unauthenticated liveness for tunnels/load balancers. → `200 {"ok":true}`.

### `GET /v1/status`

Role: `agent`. The same view `simlock status --json` reads: a `daemon` block,
managed/running capacity per platform, active leases, managed devices (each
with its device mode, `mode`: `"slim"` or `"full"`), queue depth (`queueDepth` counts the virtual line; `physicalQueueDepth` the physical one), and the warm
pool: `warmPool` carries `enabled`, `reserveRunning` (`ios`, `android`) and
`targets`, each with `platform`, `model`, `osVersion` (the one the target resolved
to, or the one it names when it did not resolve; absent when it names none and
did not resolve),
`mode`, `count`, `ready`, `booting` and, for a target the last pass could do
nothing for, `short` — one of `disabled`, `no-driver`, `runtime-missing`,
`unknown-model`, `unresolvable`, `boot-failed`, `device-limit`, `running-limit`,
`reserve` or `ram-budget`. With the pool off every configured target is
`short: "disabled"`. A gateway's own `warmPool` is empty and off; each worker's
is on its entry in `workers`.

While the daemon is starting (`daemon.health` is `starting`), the answer is
`200` with the `daemon` block, `host` and, once read, `load` only: it has not yet checked what it
holds, so `capabilities`, `devices`, `leases`, `capacity`, `queueDepth`, `physicalQueueDepth`, `installs`,
`waiting`, `warmPool` and `workers` are absent, not empty. They are all there once `health` is
`running`, and also when it is `failed`.

```json
{ "daemon": { "health": "starting", "mode": "worker" },
  "host": { "os": "macOS", "osVersion": "15.5", "arch": "arm64", "tools": [] } }
```

The daemon block carries `health` (`starting`/`running`) and **`mode`**
(`"worker" | "gateway"`), the one field that tells a client which kind of
daemon answered:

```json
{ "daemon": { "health": "running", "mode": "worker", "consoleUrl": "http://127.0.0.1:4700/" } }
```

**`consoleUrl`** is the web console's address (see [CONSOLE.md](CONSOLE.md)):
`http://<http.host>:<http.port>/`, with `localhost` for a host of `0.0.0.0` or
`::` and an IPv6 host in brackets. It is present whenever HTTP is on, so an
HTTP answer carries it; over the unix socket it is absent while HTTP is off.
It is also left out if the address would be longer than 512 characters, which
no real host name is. An older daemon sends none.

Beside it, **`host`** says what machine the daemon runs on: the operating
system, its version, the CPU architecture, and the version of each platform
tool its drivers use:

```json
"host": { "os": "macOS", "osVersion": "15.5", "arch": "arm64",
  "tools": [ { "platform": "ios", "name": "xcode", "version": "16.4", "build": "16F6" },
             { "platform": "android", "name": "emulator", "version": "35.4.9" },
             { "platform": "android", "name": "platform-tools", "version": "36.0.0" },
             { "platform": "android", "name": "cmdline-tools", "version": "19.0" } ] }
```

The daemon works these out from the machine; no config key changes them. Tool
versions are read at start and again in the background once a minute has
passed, so this endpoint never waits for them. Right after a start, or for a
tool that is not installed, `tools` has no entry for it; if a later read
fails, the last version read stays.

**`load`** is how busy the machine is, as of the daemon's last read, which it
makes every 15 seconds. It is absent until the first read finishes, and on
both the starting and the running answer once it is there:

```json
"load": { "ageMs": 4120,
  "cpu": { "busyPercent": 34.2, "cores": 10, "limited": false },
  "memory": { "totalBytes": 34359738368, "availableBytes": 10522669875,
              "swapUsedBytes": 1288490188, "pressure": "normal", "limited": false },
  "disk": { "freeBytes": 120689623040, "totalBytes": 530870820864 } }
```

`ageMs` is how old the reading is when the daemon answers, a whole number of
milliseconds up to one day. `cpu`, `memory` and `disk` are each left out when
they could not be read; `cpu` is also left out for the first 15 seconds, since
it is busy time between two reads. `pressure` (`normal`, `warn` or `critical`)
is present only where the operating system reports one. `disk` is the folder
Simlock keeps its data in. `limited` is `false` for the whole machine's figures.

Under the `resource` capacity strategy, **`capacity.ramBudget`** reports the
RAM budget; under `fixed` the field is absent:

```json
"ramBudget": { "limitBytes": 12884901888, "usedBytes": 4831838208, "overLimit": false }
```

`limitBytes` is the machine's RAM minus 4 GiB left for the OS. `usedBytes` is
the sum over every listed device that is not deleted, each at the size of the
mode it reports, so it always matches the device list. `overLimit` is true
when the use exceeds the limit, for example after a restart with larger
per-device sizes; until a device is deleted, none is created, and no
shut-down slim device boots if its slim size is smaller than the full size.

Each platform's capacity entry (`capacity.ios`, `capacity.android`) also
carries **`atRamBudget`**, always present: `true` when creating one more full
device of that platform would be refused for RAM. It is `false` under `fixed`,
which keeps no budget. A gateway reads it to prefer a worker that still has
room.

**`installs`** lists the component installs waiting or running on the
machine, whoever started them (a lease request that allowed a download, for
example), oldest first and at most 16:

```json
"installs": [
  { "platform": "ios", "component": "26.4", "state": "downloading", "since": 1790864071200, "waiters": 2 },
  { "platform": "ios", "component": "26.5", "state": "waiting", "since": 1790864075000, "waiters": 1 }
]
```

`state` is `downloading` while the platform's installer runs, and `waiting`
while the install is queued behind another one on the same platform or about
to start. `component` is the version, or the word the platform uses for its
newest. `since` is when the first request for that install arrived, in
milliseconds since the epoch, and `waiters` is how many requests wait on it.
An install leaves the list as soon as it ends, whether it succeeded, failed
or timed out. A worker always sends the field, empty when nothing is
installing; an older daemon leaves it out.

**`waiting`** lists the requests waiting in this daemon's own queue for a
device, oldest first, in the shape
[`GET /v1/lease-requests`](#get-v1lease-requests) answers. A worker always
sends it, empty when nothing waits; an older daemon leaves it out.

**`capabilities`** lists each optional module the daemon knows of, with its
state, in the order it sends them (at most 16, no name twice):

```json
[{ "name": "agent-device", "state": "unavailable", "reason": "found 0.20.1, need 0.21.25 or later" }]
```

`name` is lower-case letters, digits and `-`, starting with a letter, up to 32
characters. `state` is `available`, `unavailable` or `off`. `reason` is there
for `unavailable` only: 1 to 500 characters, with control characters replaced
by spaces. A worker with `agentDevice.enabled` `false` or unset sends
`agent-device` as `off`. A status read that takes over 1 s or fails shows
`unavailable` with `could not read <name>'s status`. A gateway's own answer
leaves `capabilities` out: each worker's list is on its entry in `workers`.

A device in `devices` that is `provisioning` or `reclaiming` carries
`transitionAgeMs`, how long it has been in that state. One that has been there
past its threshold with nothing working on it also carries
**`stalled: true`**: the same devices `simlock doctor` reports as stalled (see
`stalledTransition.*` in [CONFIGURATION.md](CONFIGURATION.md)). Every other
device has no `stalled` field, and an older daemon sends none.

Every device in `devices` carries **`servesDefaultMode`**, a boolean: whether
its pool is the one a lease request with no `mode` draws from on this daemon
(the default mode of the device's platform). `mode` says what the device is;
`servesDefaultMode` says whether a request naming no mode would get it. An
older daemon does not send it.

A physical device that has been read at least once also carries **`presence`**:
`{ "present": true }`, or `{ "present": false, "reason": "locked" | "untrusted" | "not-present" }`,
the latest read of whether it is plugged in. A simulator, an emulator and a
physical device not yet read carry none.

```json
{ "id": "dev_7", "state": "provisioning", "mode": "full", "servesDefaultMode": true, "transitionAgeMs": 412000, "stalled": true,
  "spec": { "platform": "ios", "model": "iPhone 16", "osVersion": "18.4" } }
```

On a **gateway** the numbers are the fleet's — capacity summed across connected
workers (`ramBudget` over the workers that report one, `overLimit` when any of
them is, absent when none does, and a platform's `atRamBudget` only when every
connected worker's is), every gateway-issued and local lease, every device, the
connected workers' installs (the 16 oldest across the fleet), the gateway
queue's depth and the requests waiting in it — every lease, device and install
carries the **`workerId`** it lives on, and an additive **`workers`** array
carries one
[worker view](#worker-routes) per worker:

```json
{ "daemon": { "health": "running", "mode": "gateway", "consoleUrl": "http://127.0.0.1:4700/" },
  "host": { "os": "Linux", "osVersion": "6.8.0", "arch": "x64", "tools": [] },
  "workers": [ { "id": "3f81a2c4", "label": "mac-studio-2", "connection": "connected", "drained": false } ] }
```

A gateway's own `host` is the gateway's machine and has no tools, since it
runs no drivers; each worker's is on its worker view. On a worker, `workers`
is absent and `workerId` never appears. A client that
reads neither cannot tell the difference, which is the point.

### `GET /v1/catalog?platform=ios|android`

Role: `agent`. Exactly `simlock catalog --json`. Read-only; never triggers a
download, and lists only what is installed, whatever the download policy. On
a **gateway** it is the union of the connected workers' catalogs, each model
and runtime annotated with the workers that have it — so a model the catalog
lists is leasable *somewhere* in the fleet, not necessarily on every machine
in it. On a daemon, a platform whose tools cannot be read is left out, unless
`platform` names it: then the call fails with that error.

Each platform entry carries `modelRuntimes`: for every name in `models`, the
installed runtimes that model pairs with. A pair listed there can be leased;
a model and a runtime that are each listed but not paired cannot. An empty
list means nothing installed pairs with that model. On a gateway a model is
paired with a runtime when at least one connected worker pairs them, and the
gateway sends a request only to a worker that pairs them.

Each entry also carries `modelAliases`: for a name in `models`, the other
names a lease request may use for it, in any letter case. Only models that
have another name appear; on Android that is a built-in profile's AVD id,
and iOS has none. An Android entry also carries `images`, every installed
system image with its API level (`runtime`, a value from `runtimes`), `tag`,
and `abi`, including an image whose ABI the host cannot run natively; an iOS
entry has no `images`. On a gateway `modelAliases` is the union per model and
`images` the union of each worker's images, absent when no worker's entry
for that platform has an `images` field. A gateway accepts any name a worker
lists for a model, in any letter case, and sends that worker its own name for
it.

Each entry also carries `modelClasses`: for a name in `models` whose tooling
reports one, its class, one of `phone`, `tablet`, `watch`, `tv`, `vision`,
`auto` or `desktop`. A model the tooling says nothing usable about has no
entry, and is still listed and leasable by name. On a gateway it is the union
over the connected workers; when two workers class a model differently, the
worker with the smallest id wins.

Each entry also carries `classDefaults`: for a class, the model Simlock would
create for it on that machine. It is the first name on the class's preference
list (the names in `ios.defaultModels.<class>` or `android.defaultModels.<class>`,
then Simlock's own list for the platform) that `models` lists, that is a model
of the class, and that pairs with an installed runtime; when none pairs, the
first of those that are listed and of the class. A class in which no listed
name counts has no entry. On a gateway a class's entry is kept only when every
connected worker reports the same model for it, and a worker with none for that
class counts as disagreeing.

An entry may also carry `customModels`: the names from `models` that exist
because of something on that machine rather than the platform's tools. On
Android that is a profile made with Android Studio's device manager, read
from `devices.xml`; when a built-in profile has the same name, the built-in
one wins and the model is not custom. The field is absent when there are
none, and iOS never has it. On a gateway a model is listed when any worker
that lists it marks it custom; each worker's own list is in its catalog in
[`GET /v1/workers`](#worker-routes).

```json
{ "platforms": [ {
    "platform": "ios",
    "models": ["iPhone 16", "iPhone XS"],
    "runtimes": ["18.4", "26.0"],
    "defaultRuntime": "26.0",
    "modelRuntimes": { "iPhone 16": ["18.4", "26.0"], "iPhone XS": ["18.4"] },
    "modelAliases": {},
    "modelClasses": { "iPhone 16": "phone", "iPhone XS": "phone" },
    "classDefaults": { "phone": "iPhone 16" }
  }, {
    "platform": "android",
    "models": ["My Tablet", "Pixel 8"],
    "runtimes": ["34", "35"],
    "defaultRuntime": "35",
    "modelRuntimes": { "My Tablet": ["34", "35"], "Pixel 8": ["34", "35"] },
    "modelAliases": { "Pixel 8": ["pixel_8"] },
    "modelClasses": { "My Tablet": "phone", "Pixel 8": "phone" },
    "classDefaults": { "phone": "Pixel 8" },
    "customModels": ["My Tablet"],
    "images": [ { "runtime": "34", "tag": "default", "abi": "x86_64" },
                { "runtime": "35", "tag": "google_apis", "abi": "arm64-v8a" } ]
} ] }
```

### `POST /v1/lease-requests`

Role: `agent`. Enqueues a device request.

```json
{
  "platform": "ios",
  "device": "iPhone 17 Pro",
  "os": "26.5",
  "ttlMs": 900000,
  "timeoutMs": 300000,
  "noWait": false,
  "allowDownload": false,
  "mode": "slim"
}
```

`platform` is required. A request names its device in one of three ways:
`device`, an exact model; `class`, a kind of device (`phone`, `tablet`, `watch`,
`tv`, `vision`, `auto` or `desktop`) in place of a model; or neither, which asks
for a `phone`. Sending both `device` and `class` is `400 BAD_REQUEST`. A request
with a `class`, or with neither, is granted an idle device that fits before any
device is created; when nothing idle fits it creates the first model on the
class's preference list that the machine lists (see
[Default models per class](CONFIGURATION.md#default-models-per-class)). A class
with no listed model fails with `422 UNKNOWN_MODEL`, naming the config key, and
one whose listed models pair with no installed runtime fails with `RUNTIME_MISSING`.
The granted lease's `device`, `os`, `mode` and `imageTag` always name the device
you got. `os` is an exact version (`"18.4"`) or a
range: one or more of `>=`, `>`, `<=`, `<` followed by a version, joined by single
spaces (`">=18 <26"`), or a hyphen range (`"18 - 26"`); a short version covers
everything under it, so `">=18"` is 18.0 and newer and `"<=26"` includes every
26.x. Anything written like a range but outside those forms (`^18`, `~18`, `18.x`, `*`, `||`) is `400 BAD_REQUEST`, and the message names these forms; any other string, such as `Baklava` or `34-ext12`, is an exact version. A
range is granted an idle device whose OS satisfies it, or else a new device on the
newest installed runtime in it; one no installed runtime satisfies fails at once
with `422 RUNTIME_MISSING`, `downloadable: false` and the range as `osVersion`,
whatever `allowDownload` says. `os` defaults to the newest installed runtime; `ttlMs` defaults to `lease.defaultTtlMs` and is `400 BAD_REQUEST`
above `lease.maxTtlMs`; `timeoutMs` (optional) is enforced daemon-side so a
vanished client can't hold a queue slot forever. `mode` (optional, `"slim"`
or `"full"`) is the device mode the request asks for; without it the request
gets the default mode of the worker that serves it (`ios.defaultMode`, `full`
unless configured). `full` is a guarantee: a `full` request never gets a slim
device. `slim` is best effort: on a runtime that cannot be slimmed (an iOS
runtime older than 18.5, or any Android device) the request is granted a full
device. A request only reuses an idle device of the mode it resolved to, so it
can wait for a fresh device even while devices of the other mode sit idle. See
[CONFIGURATION.md](CONFIGURATION.md#device-mode-slim-and-full) for what a slim
device leaves out.

`imageTag` (optional, Android only) is the system image type to create the
device from, such as `"google_apis_playstore"` or `"default"`: the `tag` of an
image `GET /v1/catalog` lists. Without it, Simlock picks the image itself:
`google_apis` for the host's ABI when installed, otherwise another installed
image of that API level. With it, the device is created from an installed image
of that tag, the host's ABI first; without `os` the request gets the newest API
level that has one. A request with `imageTag` never downloads: when no image of
that tag is installed for the API level it fails with `RUNTIME_MISSING`,
whatever `allowDownload` says. It only reuses an idle device created for the
same tag, and a request without `imageTag` only one created for none. On iOS
`imageTag` is `400 BAD_REQUEST`. Through a gateway, a request whose tag no
worker lists for that API level, an iOS one included, fails at once with
`422 RUNTIME_MISSING`, with or without `noWait`.

`physical` (optional, boolean) asks for an enrolled physical phone or tablet
instead of a simulator or emulator. It matches an enrolled device of the
platform by `device` (ignoring letter case), `class` and `os`; `os` is exact,
so `"18"` matches no device on `18.4.1` and "any 18.x" is `">=18 <19"`, and on
Android it is the API level (`"34"`). A request no enrolled device could match
fails at once with `422 UNKNOWN_MODEL`. One that could match a device that is
leased or being reclaimed waits, or is `503 NO_CAPACITY` with `noWait`.
`physical` with `mode` or `imageTag`, or with `allowDownload: true`, is
`400 BAD_REQUEST` naming the field. The lease's `device` then has no `mode`. A
request without `physical` never gets a physical device. A physical request
waits in a line of its own: `queuePosition` counts within it, and a simulator
request is never held behind it.

`leaseId` (optional) is the ID you want the granted lease to have, in place of
one Simlock generates: 1 to 64 ASCII letters, digits, `-` and `_`, starting
with a letter or digit, case-sensitive (`ad-7f3a` and `Ad-7f3a` are two IDs).
It has no `.`, so it can never look like a gateway's `<worker>.<lease id>`.
Everything that names the lease afterwards, `renew`, `release` and the reads,
uses that ID, on a worker and through a gateway. You promise it is unique for
all time: it names one lease, and you do not send it again once that lease has
ended. Simlock refuses an ID an active lease or a waiting request already holds
with `409 LEASE_ID_TAKEN` (the body carries `leaseId`) and does not remember
IDs that were used before. A requester that already holds `lease.maxPerRequester` leases (default 1) or a waiting
request gets `409 REQUESTER_ALREADY_LEASED` first, whatever `leaseId` it sends.

The body is strict: a key this route does not know, a `mode` other than
`"slim"` or `"full"`, an `imageTag` that is not 1 to 64 letters, digits,
`_`, `.` or `-`, a `physical` that is not a boolean, or a `leaseId` outside the
form above, is `400 BAD_REQUEST`.

`allowDownload` is now clamped through `config.downloads.policy` the same
way the socket protocol always was (**bug fix, 0.3.0**): before this
release, HTTP passed a client-supplied `allowDownload` straight through
unclamped, so a `"never"` policy could still be bypassed over HTTP even
though it already blocked the same thing on the socket. Both frontends now
go through the one shared dispatcher, so there is only one place left to get
this wrong.
An `Idempotency-Key` header (1 to 200 characters) makes the request
repeatable. Simlock stores every request before it queues it, and with a key
it stores it under that key for your token. Sending the same request again
with the same key returns `201` with the stored request instead of queueing
a second one: its current state while it is still waiting, or its result
once it has one. A result is never worked out again, even if the machine has
changed since — a request that failed with `NO_CAPACITY` stays failed. To
try again, use a new key. Repeating works across a daemon restart, for
`lease.requestRetentionMs` after the request finished (see
[CONFIGURATION.md](CONFIGURATION.md)). The same key with a different
`platform`, `device`, `os`, `mode`, `imageTag`, or `leaseId` (sent on one call and
not the other counts as different) is `409 IDEMPOTENCY_CONFLICT`. Keys
belong to your token: another token sending the same key starts a request of
its own.

Through a **gateway**, `allowDownload` does not change which worker is picked
and never starts a download: only runtimes already installed on a worker
count. It still makes the `POST` answer early, as described below. The
gateway sends the request only to a worker whose catalog can serve it: one
that lists `device` as a model or another name for one, in any letter case,
and pairs that model with `os` (or, without `os`, with at least one installed
runtime). With `imageTag`, the worker's catalog must also list an image of that
tag, for `os` when it is given. The worker is sent its own name for the model.

A request with `class`, or with neither `device` nor `class` (which means
`phone`), goes to a worker whose catalog lists a model of that class paired with
an installed runtime that satisfies `os`, or, without `os`, with at least one
installed runtime. An `os` range is forwarded as you wrote it, and so is the
class: the worker picks the model and the runtime by its own rules. A worker
holding a ready device of that class, in the range and in the mode the request
needs, is preferred over one that would create a device. A class no worker
lists a model of fails at once with `422 UNKNOWN_MODEL`, and a range none of
their models of the class pair with an installed runtime in fails at once with
`422 RUNTIME_MISSING` carrying the range as `osVersion`.

A gateway fails a request no worker can serve at once, with or without
`noWait` and `timeoutMs`, instead of queueing it. A worker *takes requests*
when it is connected, not drained, and either it has reported its capacity and
the gateway has read its catalog since it connected, or it answers that it is
still starting and the gateway holds a catalog for it from an earlier read; the
gateway *knows* a worker once it has read a catalog from it
and the worker is not `incompatible`, so a drained or disconnected worker stays
known and a reconnecting one stays known from its last catalog.

| Situation | Result |
|---|---|
| No worker takes requests, including a still-starting worker the gateway has never read a catalog from (gateway and workers restarted together) | `503 NO_CAPACITY` |
| The only worker that could serve it is still starting, and the gateway holds a catalog for it from an earlier read | Queued until the worker is ready |
| A worker takes requests, and no known worker has the platform | `422 NO_DRIVER` |
| ... and no known worker lists the model | `422 UNKNOWN_MODEL` |
| ... and no known worker has the runtime, or can pair it with the model | `422 RUNTIME_MISSING`, with `downloadable: false` and `osVersion: "default"` when `os` is absent |
| A known worker could serve it, but none that takes requests can | `503 NO_CAPACITY` |
| The request requires capabilities (not a body field; the programmatic client sends it), and no connected worker that could serve it has all of them available | `422 CAPABILITY_MISSING`, with `capabilities` naming the required ones |
| A worker that takes requests can serve it but is busy | queues; `503 NO_CAPACITY` only with `noWait: true` |

A request that is already waiting is held to the same table: when the only
worker able to serve it is drained or disconnects, the request ends `failed`
with `NO_CAPACITY`. After a gateway restart a worker is not known until it
reconnects.

On a single host, with `allowDownload: true` the `201` is returned as soon as
the request is stored — resolving a downloadable runtime can take minutes, so progress and
any later failure surface on the request resource instead of on the `POST`
itself. A refusal that comes before the request is stored
(`409 REQUESTER_ALREADY_LEASED`, `409 LEASE_ID_TAKEN`, `400` for a `ttlMs` above `lease.maxTtlMs`)
still fails the `POST`. Through a gateway the flag changes nothing about the
`POST`: it never downloads, so a request no worker can serve fails it as
above.

→ `201`, `Location: /v1/lease-requests/{id}`:

```json
{ "request": { "id": "req_7d1a", "state": "queued", "queuePosition": 2, "createdAt": "2026-09-01T09:12:00Z" } }
```

A rejection that lands before any device work is claimed for the request
fails the `POST` itself instead of the client having to poll to learn about
it: `409 REQUESTER_ALREADY_LEASED` (names the existing lease id), `422` for
an unknown model / missing runtime / no driver, `503 NO_CAPACITY` (with
`Retry-After`) when `noWait` is set. A gateway also answers these at once for
a request no worker can serve, `503 NO_CAPACITY` included, whatever `noWait`
says (see the table above). Anything that fails once device work is
already in flight surfaces as the request resource's terminal `failed` state
instead — see the state list below.

### `GET /v1/lease-requests/{id}`

Role: `agent` (its own requests; `operator` sees all). Poll the request.
`?wait=<seconds>` long-polls: returns as soon as the state changes, else
once `wait` elapses. `wait` is capped at 60 seconds — a larger value is
clamped, not rejected, and the poll simply returns (unchanged) sooner than
asked; re-poll to keep waiting.

States: `queued | downloading | reclaiming | provisioning | booting |
granted | failed | cancelled`, carrying `queuePosition` (`queued`) or
`etaSeconds` (`reclaiming`/`provisioning`/`booting`) where the stage has one.
Terminal `granted` embeds the [lease object](#the-lease-object); terminal
`failed` embeds `{ code, message }`.

`downloading` is a request with `allowDownload: true` waiting on the download
of a missing runtime, before any device work:

```json
{ "request": { "id": "req_7d1a", "state": "downloading", "component": "26.4", "waiting": false, "percent": 41, "createdAt": "2026-09-01T09:12:00Z" } }
```

`component` names what is being downloaded, as the platform names it: an iOS
version or an Android API level, for example. `waiting` is `true` while
another download on the same platform runs ahead of this one, and `false`
once this download runs. `percent`, a whole number from 0 to 100, is there
when the platform's installer printed one. A request that joins a download
already running shows that download's latest state at once. A request that
needs no download never shows this state.

The request is the one Simlock stored, so `GET` answers across a daemon
restart and for a request your token sent over the socket too. A finished
request answers for `lease.requestRetentionMs`, then `404`. A `granted`
request's lease object is the lease as it was granted: after a renew, read
the current deadline from [`GET /v1/leases/{id}`](#get-v1leasesid).

### `GET /v1/lease-requests/{id}/events`

Role: `agent` (ownership as above). Server-Sent Events stream of the same
progress objects, one event per state change, named after the state
(`queued`, `downloading`, `provisioning`, ...), ending with `granted` or
`failed`. A `: keepalive` comment every ~15s keeps idle tunnels from closing
the stream.

### `DELETE /v1/lease-requests/{id}`

Role: `agent` (ownership as above). Cancel a pending request.

→ `204` if it was still cancellable (no device work claimed for it yet).
`409 REQUEST_NOT_CANCELLABLE` once a download or device work is in flight, or the request
already reached a terminal state — the body names the lease id if it was
`granted` (release that instead). `404 UNKNOWN_LEASE_REQUEST` if unknown.

### The lease object

A lease issued by a **gateway** — a worker's own lease is the same object
without the `workerId` and `worker` fields:

```json
{ "lease": {
    "id": "3f81a2c4.lse_9f2c", "requestId": "req_7d1a",
    "platform": "ios", "device": "iPhone 17 Pro", "os": "26.5",
    "udid": "ABCD-...", "deviceId": "dev_1a2b",
    "workerId": "3f81a2c4", "worker": { "id": "3f81a2c4", "label": "mac-studio-2" },
    "createdAt": "2026-09-01T09:14:07Z",
    "expiresAt": "2026-09-01T09:29:07Z", "ttlMs": 900000,
    "dataPlane": null, "mode": "slim"
} }
```

`worker` (and the flat `workerId`, which mirrors it for the aggregate lists)
is present when a **gateway** issued the lease and absent from a worker's own
— it says which machine the device lives on, so a client and the console can
show it. `label` is display-only. A worker's network address is deliberately
never here: clients reach the device through the gateway, with
[`POST /v1/leases/{id}/exec`](#post-v1leasesidexec).

A lease whose ID Simlock generated has an `id` that names its worker
(`<workerId>.<worker's own lease id>`, split on the **first** `.`). A worker id is a UUID, so a
real id reads `3f81a2c4-9b7d-4e21-8a55-1c0e6f2d7b93.lse_9f2c`; the examples
here and elsewhere in these docs abbreviate it to its first segment for
legibility. A lease whose requester chose the ID (`leaseId` on
[`POST /v1/lease-requests`](#post-v1lease-requests)) keeps exactly that ID,
with no worker in front of it. A gateway routes every lease, generated or
chosen, from a table it keeps in memory and rebuilds from its workers after a
restart, so for a moment after a restart, renew and release of any lease can
answer `404 UNKNOWN_LEASE` until its worker has reported. **Treat the whole id as opaque** — pass it back
verbatim in paths and bodies, and read `worker.id` when you want the machine.

`dataPlane` is **reserved** and always `null` in this version: streaming a
device's screen, forwarding a port, or opening an interactive TTY is a
separate, not-yet-implemented concern — see [Not
implemented](#not-implemented) below. It is in the schema now so its arrival
is additive rather than a breaking shape change. Running a *command* on the
device is not part of it and does not wait for it: that is `exec`, below.

`mode` is the device mode the granted device actually has: `"slim"` when its
feature set was reduced, `"full"` otherwise — always `"full"` for Android. A
`"slim"` request can be granted `"full"` (slim is best effort); a `"full"`
request is never granted `"slim"`. It lets a client explain a
feature-loss failure (missing push notification, Spotlight result,
StoreKit sheet, universal link, or system picker) instead of misreading it
as a bug.

`imageTag` is present on a lease whose request named one: the image tag the
device was created from. A lease whose request named none has no `imageTag`.

### `GET /v1/leases/{id}`

Role: `agent` (own lease; `operator` any). Re-fetches the lease — a client
that restarts mid-lease recovers its state instead of leaking the lease.
`404 UNKNOWN_LEASE` both once it has expired or been released, and for
another requester's own, still-live lease: this route (and `GET
/v1/leases/{id}/events` below) has no dispatcher operation to defer to for a
single-lease read, so it resolves the lease the same way `lease.list`'s
handler already filters leases — to the session's own set, admin sees all —
and an id outside that set simply isn't in the list. `404` covers "doesn't
exist" and "not yours" identically, the same way `lease.list` itself does
not distinguish them.

`POST /v1/leases/{id}/renew`, `DELETE /v1/leases/{id}`, and `POST
/v1/leases/{id}/exec` are different: all three dispatch their operation
(`lease.renew`, `lease.release`, `device.exec`) directly, so another
requester's own, still-live lease answers `403 FORBIDDEN` from them — the
same answer the socket transport gives, via the same operation's `ownsLease`
authorize hook.

This is different again from the lease-*request* routes below
(`/v1/lease-requests/{id}` and friends), which answer `403 FORBIDDEN` for a
request another token sent.

`expiresAt` is always the authoritative deadline, and `ttlMs` is always the
lease's own width — the TTL it was granted with, or last renewed with when a
renew carried one. The daemon stores it on the lease record, so it survives a
**daemon** restart along with the deadline and the restored TTL timer.
`requestId` names the request that was granted this lease. It is present
while that request is still stored, which is `lease.requestRetentionMs` after
it was granted, and omitted after that. Schedule renewals from `expiresAt` rather than from
`ttlMs` all the same: the deadline is the fact, the width is how far the next
body-less renew will push it.

### `POST /v1/leases/{id}/renew`

Role: `agent` (own lease). Body `{ "ttlMs": 900000 }` — optional, and
omitting it re-applies the lease's own `ttlMs` rather than
`lease.defaultTtlMs`, so a lease keeps the width it was granted with. A
`ttlMs` above `lease.maxTtlMs` is `400 BAD_REQUEST`; one below it changes the
lease's width from this renew on. Either way the deadline resets to now + ttl,
regardless of how much time was left. This is the only thing that keeps a
lease alive.

→ `200 { "leaseId": "lse_9f2c", "expiresAt": "...", "notices": [] }`

`notices` is an HTTP-side convenience, not part of the socket contract's
`lease.renew` response: `LeaseNoticeBuffer` (`src/http/notices.ts`) collects
the owner-routed device-health facts a socket client would have received as
pushes, and drains them here. It carries the facts observed since the
previous renew for this lease — `{"event":"device_unhealthy"}`,
`{"event":"device_recovered","attempts":1}` — so a polling-only client
learns its device blinked without holding a stream open.

### `GET /v1/leases/{id}/events`

Role: `agent` (own lease). Server-Sent Events for live health pushes on this
lease: `device_unhealthy`, `device_recovered`, `lease_lost` (ends the
stream). The same facts a running `simlock lease` relays on stderr. Losing
this stream tells you nothing about the lease — it is still yours until
`expiresAt`; reconnect, or read the health facts from `renew`'s `notices`.

`lease_lost` is the one fact `notices` cannot carry: it ends the lease, so
there is nothing left to renew and nothing to drain the buffer on. A polling
client learns it the other way round — the next `POST /v1/leases/{id}/renew`
against an ended lease answers `404 UNKNOWN_LEASE`.

### `POST /v1/leases/{id}/exec`

Role: `agent` (own lease); `operator` must name the lease's requester — see
below. Runs one `simctl`, `adb` or `devicectl` command **on the machine that owns the
device** and streams its output back. This is what makes a leased device
drivable from here at all — over HTTP against a lone worker, and through a
gateway to whichever worker holds the lease, with the same request and the
same response either way.
Every other way of reaching a device assumes the caller shares that
machine's filesystem.

```json
{ "tool": "simctl", "args": ["list", "devices"], "stdin": "y\n" }
```

`tool` names a driver passthrough — `simctl`, `adb` or `devicectl` on the
machines this version runs on. `devicectl` serves a physical iOS lease only,
runs the reviewed `device …` commands, and gets `--device <UDID>` added for the
leased device when the arguments name none; `simctl` on a physical lease and `devicectl` on a simulator
lease are `422 PASSTHROUGH_REFUSED`. The contract does not close that set;
the drivers installed there do, and one they do not claim is `422 UNKNOWN_PASSTHROUGH_TOOL`. `args`
is the argument vector. The daemon that owns the device resolves it through
the same driver passthrough logic `simlock simctl` / `simlock adb` use
locally — the same root scoping (`--set` for iOS, `-P` for Android, supplied
by simlock and refused from the caller), and the same refusal list for verbs
that would change a device's lifecycle behind the registry's back
(`create`/`erase`/`delete`, `shutdown all`, `runtime delete`, `kill-server`,
`emu kill`, …). A refused verb is `422 PASSTHROUGH_REFUSED` here too and
nothing is spawned for it. For `simctl` and `adb` on a virtual device nothing else about the
arguments is parsed, they are passed through unchanged, and the *device* is
named by them, not by the lease: the lease id is the ownership proof. For `adb`
on a leased physical Android device the driver refuses an argument list that
starts with a flag, the subcommands that would stop, start or move a server or
transport (`kill-server`, `connect`, `tcpip`, `usb`, …) and a reboot into the
bootloader, recovery or sideload, and it adds `-P 5037 -s <serial>` of the
leased phone itself. For
`devicectl` the driver checks the arguments against the reviewed list above
and adds `--device <UDID>` of the leased device unless they name one. A
gateway in the path parses none of this — it proxies the call to the owning
worker and relays the stream back unchanged.

`stdin` (optional) is a single string, sent with the request, written to the
command once, and the pipe is then closed — there is no incremental stdin
channel and no pseudo-terminal, so line-oriented commands work and
full-screen or interactive ones do not: a bare `adb shell`, which *is* the
interactive shell, is refused (`422 PASSTHROUGH_REFUSED`, "needs a
terminal") rather than left to hang on a pipe until the timeout.

`requesterId` (optional) names the agent this command is being run *for*,
and is read **only from an `operator` token** — the proxying case a
gateway's own admin session needs, fronting many agents over one uplink
credential. Identity is otherwise never client-declared here (see
[Authentication](#authentication)): an `agent` token is authorized against
the lease it holds, exactly as it is for renew and release, and if it
supplies a `requesterId` at all — even its own — the call is `403 FORBIDDEN`.
That rejection lives in `device.exec`'s own `authorize` hook, not this
route, so the unix socket and any future transport answer it the same way;
answering a request that named an identity as if it had named none would
read like authorization. An `operator` token is held to this field instead
of getting the usual operator bypass, and does not default past it: omitted,
it falls back to the operator's own principal, and either way it must name
the requester the lease was actually granted to, or the call is the same
`403 FORBIDDEN`. That is what lets a gateway proxy many agents over one
operator credential without any of them reaching another's device —
ownership ends up checked on both hops, the gateway against its own lease
index and the worker against the lease it actually holds.

→ `200`, `Content-Type: text/event-stream`, the same SSE shape
`/v1/lease-requests/{id}/events` uses. One event per chunk of output as it is
written, then exactly one terminal event:

```
event: output
data: {"stream":"stdout","chunk":"== Devices ==\n"}

event: output
data: {"stream":"stderr","chunk":"No devices found\n"}

event: exit
data: {"exitCode":0}
```

`chunk` is whatever the command wrote, decoded as UTF-8 and forwarded
unsplit — not a line, not a frame — so a command whose output is genuinely
binary (`simctl io booted screenshot -` to stdout) is not supported over
this route; have it write to a file on the device's own machine instead.
Output is streamed and never buffered by the daemon, so there is no size cap
and the first chunk arrives while the command is still running; a client
that wants lines assembles them itself. A `: keepalive` comment every ~15s
keeps idle tunnels open, as elsewhere.

A failure that lands **before the command is spawned** is answered as an
ordinary JSON error with its own status instead of a stream:

- `403 FORBIDDEN` — another requester's lease (dispatched through the
  operation's own ownership hook, like renew and release), an `agent` token
  that supplied a `requesterId` at all, or an `operator` token whose
  `requesterId` doesn't match the lease's.
- `404 UNKNOWN_LEASE` — no such lease, or it has expired or been released.
- `400 BAD_REQUEST` — a malformed body, nothing more.
- `422 PASSTHROUGH_REFUSED` — a refused verb, a caller-supplied `--set`/`-P`,
  or a bare `adb shell`.
- `422 UNKNOWN_PASSTHROUGH_TOOL` — a `tool` no driver on that machine claims.
- `503 WORKER_UNREACHABLE` — a gateway could not reach the worker holding
  the lease.

The status commits at the **spawn**, not at the first byte: the moment the
child process exists the response is `200` and the stream is open, even if
the command has not written anything yet (`simctl install` on a large
bundle says nothing for a while, and a client should not have to guess
whether that silence means the request was accepted). Everything after that
point arrives as a terminal event instead:

```
event: error
data: {"error":{"code":"EXEC_TIMEOUT","message":"..."}}
```

`EXEC_TIMEOUT` is the daemon killing a command that outran `exec.timeoutMs`
(ten minutes by default on the worker, see
[CONFIGURATION.md](CONFIGURATION.md)) — reported instead of the exit code
the kill produced, because "we stopped it" and "it failed" are different
answers. The worker's own `exec.timeoutMs` is authoritative, since that side
owns the process and is the only one that can kill it; a gateway in the path
adds `gateway.execTimeoutMs` (eleven minutes) only as a backstop for a
worker that never answers at all — deliberately the longer of the two, so an
ordinary timeout surfaces as the worker's own `EXEC_TIMEOUT` rather than
racing the gateway's. `EXEC_TIMEOUT` is `504` in the contract's error table,
though on this route the status never reaches the client: the response is
already `200` and streaming by the time a command can time out, so it
arrives as the stream's terminal `error` event instead; the code is
documented anyway for a client mapping it without a route in front of it.
Disconnecting does **not** kill the command — the daemon simply stops
writing its output, the same way closing a connection releases no lease;
the timeout is what bounds it.

Paths in `args` resolve on the daemon's filesystem
(`{"tool":"simctl","args":["install","booted","/build/MyApp.app"]}` needs
that path to exist *there*). Getting a file onto that machine is not part of
this API in this version — see [Not implemented](#not-implemented).

### `POST /v1/components/install`

Role: `operator`. Installs one iOS simulator runtime or Android system image
on this machine, without leasing a device — the same operation as
`simlock component install`.

```json
{ "platform": "android", "version": "35" }
```

`version` is the string `GET /v1/catalog` lists under `runtimes` once the
component is installed (`26.4` for an iOS runtime, `35` for an Android API
level): 1 to 64 characters, none of them whitespace or a control character, and
not starting with `-`.
The request is the consent to download, so it needs no `allowDownload`; under
`downloads.policy: "never"` it is refused (see
[CONFIGURATION.md](CONFIGURATION.md#downloads)).

A failure that lands **before the install takes the request** is answered as
an ordinary JSON error with its own status:

- `403 FORBIDDEN` — an `agent` token.
- `403 DOWNLOADS_DISABLED` — `downloads.policy` is `"never"`; nothing is
  downloaded.
- `400 BAD_REQUEST` — a malformed body or version.
- `422 NO_DRIVER` — no driver for that platform on this machine.
- `501 UNSUPPORTED_IN_GATEWAY_MODE` — the daemon is a gateway, which owns no
  components, and the body names no `workers`; name the workers to install
  on (below).

Once the install has taken the request the response is `200`,
`Content-Type: text/event-stream`, the same SSE shape the exec route uses:
`progress` events while it runs, then exactly one terminal `result` or
`error` event.

```
event: progress
data: {"stage":"waiting"}

event: progress
data: {"stage":"downloading","fraction":0.41}

event: result
data: {"platform":"android","component":"35","outcome":"installed","version":"35"}
```

`waiting` means another download on the same platform runs first; a
platform downloads one component at a time. `fraction`, from 0 to 1 with at
most three decimals, is present when the platform's installer reports one;
an install that ends `installed` reports 1 before its result. `outcome` is `installed`,
or `already-installed` when the component was already there (repeating the
request changes nothing); `version` is the exact version installed. A failure
after that point is the terminal `error` event, in the exec route's shape —
`INSUFFICIENT_DISK_SPACE` (checked before the download starts),
`LICENSE_NOT_ACCEPTED`, or `DOWNLOAD_TIMEOUT` when `downloads.timeoutMs`,
counted from the request and waiting included, runs out. A `: keepalive`
comment every ~15s keeps idle tunnels open.

Disconnecting does **not** stop the install. Repeating the request while it
runs joins it and gets its result; repeating it after it finished answers
`already-installed`. A lease request for the same component joins the same
download too.

#### On a gateway's workers

Against a gateway, add `workers`: a list of 1 to 64 worker ids, as
`GET /v1/workers` shows them, or `"all"` for every connected worker.

```json
{ "platform": "android", "version": "35", "workers": "all" }
```

The gateway asks every targeted worker at the same time, and each one
installs the component itself under its own `downloads.policy`, Android
license setting, disk check and `downloads.timeoutMs`. A worker set to
`downloads.policy: "never"` refuses; the gateway has no download policy of
its own and stores or forwards no image. A drained worker is asked like any
other. `workers` on a single host is `501 UNSUPPORTED_IN_WORKER_MODE`; leave
it out to install on that host.

Before any worker is asked, these are JSON errors:

- `403 FORBIDDEN` — an `agent` token.
- `400 BAD_REQUEST` — a malformed body, version, or worker list (empty, more
  than 64, or an id twice).
- `404 UNKNOWN_WORKER` — a named id the gateway does not know.
- `503 WORKER_UNREACHABLE` — a named worker that is disconnected, speaks an
  incompatible protocol, or whose config the gateway has not read yet.

Then the response is the same event stream. Each `progress` event carries the
`workerId` it came from, and the terminal `result` event lists one entry per
worker, in ascending worker id:

```
event: progress
data: {"stage":"downloading","fraction":0.41,"workerId":"3f81a2c4"}

event: result
data: {"results":[{"workerId":"3f81a2c4","label":"mac-studio-2","outcome":"installed","version":"35"},{"workerId":"9b07de11","outcome":"refused","error":{"code":"DOWNLOADS_DISABLED","message":"..."}}]}
```

`outcome` is one of:

- `installed` / `already-installed` — the worker's own answer, with the exact
  `version`.
- `refused` — the worker's `downloads.policy` is `"never"`.
- `failed` — the worker answered with another error; `error.code` is the
  worker's own.
- `skipped` — `"all"` only: the worker could not be asked (disconnected,
  incompatible, or its config not read yet). It is not asked when it comes
  back.
- `unknown` — the worker's connection dropped during its install, or it did
  not answer within its own `downloads.timeoutMs` plus one minute. The
  install carries on on the worker; `GET /v1/catalog` shows the component
  once it is there and the worker is connected.

Every outcome but the first two carries `error: {code, message}`. A
worker's new component is in the gateway's `GET /v1/catalog` by the time the
`result` event is sent, unless the gateway could not read that worker's
catalog just then; its next read brings it in. Nothing is retried or kept for
later.

### `GET /v1/components?platform=ios|android`

Role: `agent`. Lists every iOS simulator runtime and Android system image
installed on this machine, whoever installed it — the same answer as
`simlock component list`. It changes nothing. Without `platform`, both
platforms are listed.

```json
{
  "components": [
    {
      "platform": "android",
      "version": "35",
      "variant": "google_apis/arm64-v8a",
      "sizeBytes": 4201234567,
      "installedBySimlock": true,
      "installedAt": 1790864071200,
      "devices": 2,
      "foreignDevices": 0
    }
  ]
}
```

Entries are ordered by platform, then version, then variant. `version` is
the string `GET /v1/catalog` lists under `runtimes`; `variant` tells two
components of one version apart (an iOS runtime's build, an Android image's
tag and ABI). `sizeBytes` is left out when it cannot be read.
`installedBySimlock` is `true` only for a component Simlock installed that is
still the same one on disk, and `installedAt` is when it did. `devices`
counts Simlock's own devices of this platform and version that have not been
deleted; two variants of one version show the same count. `foreignDevices`
counts the devices outside Simlock that use the component: simulators in
Xcode's default device set that have been booted at least once, and every
AVD in the user's own AVD home. The simulators macOS creates by itself for
each runtime it installs do not count until someone boots one.

A platform whose tools cannot answer is left out. `400 BAD_REQUEST` for a
`platform` other than `ios` or `android`; `501 UNSUPPORTED_IN_GATEWAY_MODE`
from a gateway, which owns no components — ask the worker.

### `DELETE /v1/components/{platform}/{version}`

Role: `operator`. Removes one iOS simulator runtime or Android system image
that Simlock installed on this machine, to get its disk back — the same
operation as `simlock component remove`. `?dryRun=true` runs every check a
removal runs and removes nothing.

```
DELETE /v1/components/ios/26.4
DELETE /v1/components/ios/26.4?dryRun=true
```

The answer is one JSON body, not a stream:

```json
{ "platform": "ios", "version": "26.4", "outcome": "removed", "sizeBytes": 9103456789 }
```

`outcome` is `removed`, or `would-remove` for a dry run. `sizeBytes` is the
disk the component took, left out when it could not be read. `residue`
appears when something stayed behind after the removal, and names each
thing. On iOS that is the runtime's never-booted simulators in Xcode's
default device set, which become unavailable (`residue` says how many, and
that `xcrun simctl delete unavailable` clears them), and the runtime's
download when macOS keeps it in its own asset store (remove the platform in
Xcode's Settings, under Platforms). Simlock deletes neither.
A removed component leaves `GET /v1/catalog` and `GET /v1/components` at once,
and the removal is reported as a `component.removed` event naming who asked.

A component is removed only when Simlock installed it and it is still the same
one on disk, no device uses it, and nothing else installs or removes on that
platform. Each refusal removes nothing:

- `409 COMPONENT_NOT_OWNED` — Simlock did not install it, or it changed on
  disk since. There is no way to force it.
- `409 COMPONENT_IN_USE` — a device uses it: one of Simlock's, in any state,
  leased ones included, or one outside Simlock (a simulator in Xcode's
  default device set that has been booted at least once, an AVD in the
  user's own AVD home). Never-booted simulators do not block it. The body carries
  `devices` and `foreignDevices`, how many of each.
- `409 COMPONENT_BUSY` — an install or removal runs or waits on that
  platform; try again once it ends.
- `403 FORBIDDEN` — an `agent` token.
- `400 BAD_REQUEST` — a platform other than `ios` or `android`, a malformed
  version, or a `dryRun` other than `true` or `false`.
- `501 UNSUPPORTED_IN_GATEWAY_MODE` — the daemon is a gateway, which owns no
  components; ask the worker.

```json
{ "error": { "code": "COMPONENT_IN_USE", "message": "...", "devices": 1, "foreignDevices": 2 } }
```

### `POST /v1/devices`

Role: `operator`. Enrols a phone or tablet plugged into the machine the
daemon runs on, the same operation as `simlock device add`. The body is
exactly `platform` and `id`; any other field is `400 BAD_REQUEST`.

```json
{ "platform": "ios", "id": "00008110-001A2B3C4D5E" }
```

→ `200`

```json
{ "id": "dev_8f2a", "driverDeviceId": "00008110-001A2B3C4D5E", "platform": "ios",
  "model": "iPhone 15 Pro", "osVersion": "18.4", "class": "phone", "appCount": 12,
  "reenrolled": false }
```

`id` is the registry id; `driverDeviceId` is the canonical ID, which
`DELETE /v1/devices/{id}` takes. Enrolling an enrolled device again keeps its
registry id and answers `reenrolled: true`.

- `422 DEVICE_NOT_ENROLLABLE` — the driver refused, or the ID names a
  simulator or emulator, or a device enrolled on the other platform. The body
  carries `id` (as sent), `platform`, `reason` and, when known,
  `canonicalId`.
- `409 DEVICE_BUSY` — the device is leased, reclaiming or held by another
  operation. The body carries `id` and `reason` (`leased`, `reclaiming` or
  `busy`).
- `422 NO_DRIVER` — no driver for the platform.
- `403 FORBIDDEN` — an `agent` token.
- `400 BAD_REQUEST` — an unknown field, a platform other than `ios` or
  `android`, or an `id` over 200 characters, with whitespace or a control
  character, or starting with `-`.
- `501 UNSUPPORTED_IN_GATEWAY_MODE` — the daemon is a gateway; ask the worker
  the device is plugged into.

### `DELETE /v1/devices/{id}`

Role: `operator`. Forgets an enrolled phone or tablet, the same operation as
`simlock device remove`. `{id}` is the canonical ID (`driverDeviceId`),
URL-encoded. Nothing is sent to the device.

→ `200 { "id": "dev_8f2a", "driverDeviceId": "00008110-001A2B3C4D5E" }`

`id` is the registry id, as `POST /v1/devices` answers it.

- `404 UNKNOWN_DEVICE` — no enrolled device has that ID.
- `409 DEVICE_BUSY` — the device is leased, reclaiming or held by another
  operation.
- `403 FORBIDDEN` — an `agent` token.
- `501 UNSUPPORTED_IN_GATEWAY_MODE` — the daemon is a gateway.

### `DELETE /v1/leases/{id}`

Role: `agent` (own lease); `operator` may release any lease.

→ `202 { "released": true, "device": { "id": "dev_1a2b", "state": "reclaiming" } }`

The lease is gone the moment this responds; the driver-side purge continues
in the background (existing release semantics: release hands the
purge off), hence `202`, not `200`.

### `GET /v1/uplink` (WebSocket upgrade)

Role: `worker`. The endpoint a **worker** dials to join a fleet: it opens
one outbound WebSocket to `<gateway.url>/v1/uplink`, presenting
`Authorization: Bearer slk_<join-token>` on the upgrade request along with
its instance id. The gateway verifies the token against its own store and
requires role `worker`; a missing or unrecognized token is `401
UNAUTHENTICATED`, and a valid token of any other role is `403 FORBIDDEN`.
Revoking the token closes the uplink.

This is the fleet's **only** inbound connection. Workers dial out, so a
machine behind NAT, on a laptop, or on a CI runner joins with a URL and a
token and needs no inbound port of its own, and no client ever learns a
worker's address.

What travels over the socket is not a new API: it is the same typed daemon
contract, with **the gateway as the protocol client**. It sends
`hello`, negotiates the protocol range exactly as over the unix socket, and
then issues ordinary operations (`status.get`, `list.get`, `catalog.get`,
`events.subscribe`, `lease.request`, `device.exec`, …) to the worker's own
dispatcher, exactly as a local admin CLI would. A worker whose range does not
overlap the gateway's is marked `incompatible` and never dispatched to; it
keeps serving its own local clients.

Nothing else about this endpoint is a REST resource: there is no `GET` body,
no polling, and no route to list uplinks. The connection *is* the worker's
liveness signal — [`GET /v1/workers`](#worker-routes) is how you look at it.

### Worker routes

Role: `operator` for all four. They exist on a **gateway** and on a single
host. A single host answers as a fleet of one: `GET /v1/workers` lists the
host itself, and the other three answer `501 UNSUPPORTED_IN_WORKER_MODE`.

- `GET /v1/workers` — every worker view the gateway currently holds, or the
  host's own view on a single host. A worker whose `health` is `starting` has
  not yet checked what it holds, so its view carries `health` and `host` and
  none of `devices`, `leases`, `capacity`, `warmPool`, `queueDepth`, `physicalQueueDepth`, `catalog`, `installs`
  or `waiting`: they are absent, not empty, until the worker answers `running`.
- `POST /v1/workers/{id}/drain` — stop dispatching new requests to this
  worker; it keeps the leases it already has.
- `DELETE /v1/workers/{id}/drain` — undrain it, putting it back in rotation.
- `DELETE /v1/workers/{id}` — forget a worker's view.

`GET /v1/workers`, a real answer from a test fleet whose drivers are
simulated (hence the thin Android catalog), trimmed to one worker:

```json
{
  "workers": [
    {
      "id": "2b026432-7743-4a08-98fc-ce494d11866f",
      "label": "worker-a",
      "connection": "connected",
      "drained": false,
      "lastSeenAt": 1790864080506,
      "catalogReadAt": 1790864071200,
      "health": "running",
      "version": "1.0.0",
      "capacity": {
        "ios": {
          "running": 0,
          "maxRunning": 8,
          "reserved": 0,
          "overLimit": false,
          "atRamBudget": false,
          "limit": 8,
          "warm": 0,
          "used": 0
        },
        "android": {
          "running": 0,
          "maxRunning": 8,
          "reserved": 0,
          "overLimit": false,
          "atRamBudget": false,
          "limit": 8,
          "warm": 0,
          "used": 0
        },
        "global": {"running": 0, "maxRunning": 8, "reserved": 0, "overLimit": false, "warm": 0}
      },
      "downloads": {"policy": "on-request", "timeoutMs": 1200000},
      "lease": {"maxTtlMs": 14400000},
      "queueDepth": 0,
      "physicalQueueDepth": 0,
      "leases": [],
      "devices": [],
      "installs": [
        {"platform": "ios", "component": "26.4", "state": "downloading", "since": 1790864071200, "waiters": 1}
      ],
      "catalog": [
        {
          "platform": "ios",
          "models": ["iPhone 16"],
          "runtimes": ["18.4", "26.0"],
          "defaultRuntime": "26.0",
          "modelRuntimes": {"iPhone 16": ["18.4"]},
          "modelAliases": {},
          "modelClasses": {"iPhone 16": "phone"},
          "classDefaults": {"phone": "iPhone 16"}
        },
        {
          "platform": "android",
          "models": [],
          "runtimes": ["18.0"],
          "defaultRuntime": "18.0",
          "modelRuntimes": {},
          "modelAliases": {},
          "modelClasses": {},
          "classDefaults": {},
          "images": [{"runtime": "18.0", "tag": "google_apis", "abi": "arm64-v8a"}]
        }
      ],
      "host": {
        "os": "macOS",
        "osVersion": "26.6.1",
        "arch": "arm64",
        "tools": [{"platform": "ios", "name": "xcode", "version": "16.4", "build": "16F6"}]
      }
    }
  ]
}
```

`catalogReadAt` is when the gateway last read that worker's catalog since the
worker connected. It is absent until the first read, and again after the
worker reconnects until its new catalog arrives; a worker without it takes no
requests (see the table under `POST /v1/lease-requests`).

`downloads.policy` and `downloads.timeoutMs` are that worker's own effective
config, read when its uplink connects, again on every periodic refresh, and
after the worker installs a component. The policy is shown for reference;
routing does not read it, since no download is started through a gateway.

`installs` is the worker's own `installs` list from its
[`GET /v1/status`](#get-v1status). It is re-read when an install on that
worker starts, finishes or fails, and on every periodic refresh, so an
install queued behind another may appear only then. A worker that does not
send one shows an empty list; a disconnected or incompatible worker shows
none.

`capabilities` is the worker's own `capabilities` list from its
[`GET /v1/status`](#get-v1status): which optional modules it serves, such as
agent-device. It is re-read on every refresh, so a change shows at the next
periodic refresh at the latest. A starting or incompatible worker shows none;
a disconnected worker keeps the list it last read.

`waiting` is the worker's own `waiting` list from its
[`GET /v1/status`](#get-v1status): the requests waiting in that worker's
queue. It is re-read on every lease event on that worker. A worker that does
not send one shows an empty list; a disconnected or incompatible worker shows
none.

`catalog` is what that worker can lease, each model with the runtimes it
pairs with, and lists a newly installed component as soon as its install
ends. Its `customModels` are that worker's own, so this is where you see
which worker has a custom Android profile. `host` is the worker's machine, the same block its own
`GET /v1/status` reports, as of the gateway's last refresh: a tool installed
or upgraded on the worker shows here without a restart of either side.

`devices` are the worker's devices as its own
[`GET /v1/status`](#get-v1status) reports them, `stalled` included. A device
stalls with no event to report it, so the gateway shows a new stall after its
next periodic refresh of that worker.

`protocol` appears only on an `incompatible` worker: it names both ranges,
the worker's and the gateway's, so you can see which side to upgrade. A worker
too old to overlap is the ordinary upgrade path, not a fault, and its view
carries no `host`, since the gateway asks it nothing.

`connection` is `connected`, `disconnected`, or `incompatible`. A worker view is
rebuilt over the uplink and never persisted, so these are current facts, not
a registry: a worker appears by connecting, and there is deliberately no
route that *adds* one.

A **disconnected** worker keeps its last-known view (greyed in the console,
never dispatched to) until an operator removes it or
`gateway.disconnectedRetentionMs` (24 hours) elapses. The clock is held while
the gateway still knows of gateway-issued leases on that worker — forgetting
a worker that holds someone's device is how a lease becomes unroutable — and
that hold ends when the last of those leases passes its deadline, since a
lease nobody can renew is one the worker has expired on its own clock.

`POST /v1/workers/{id}/drain` → `200 { "workerId": "3f81a2c4", "drained":
true }`; `DELETE /v1/workers/{id}/drain` → `200 { "workerId": "3f81a2c4",
"drained": false }`. Both are `404 UNKNOWN_WORKER` for an id the gateway does
not know: draining is an instruction about a specific machine, and silently
succeeding against one that is not there would hide a typo in exactly the
situation — taking a machine out of service — where an operator most needs to
know the instruction landed.

`DELETE /v1/workers/{id}` → `200 { "workerId": "3f81a2c4", "removed": true }`,
or `409 WORKER_CONNECTED` when its uplink is still open — a connected worker
would simply reappear, so drain it and stop it (or revoke its join token)
first. Unknown ids are the one place remove differs: `200 { "removed": false
}`, not `404`, because "forget this worker" is already true of a worker the
gateway has already forgotten — the same reading `token.revoke` gives an
unknown token id.

On a **single host** (a daemon in `worker` mode), `GET /v1/workers` returns
one view, the host itself, with the fields a gateway shows for each of its
workers except `catalogReadAt`, which is a gateway's record of reading a
worker and is always absent here. `id` is the id the host presents to a gateway, `label` is its
`gateway.label` (absent when unset), `connection` is `connected`, `drained`
is `false`, and `lastSeenAt` is the time of the request. Every other field
comes from the host's own status, devices, catalog and config. Status and
devices are read on every request. The catalog is read again every 30
seconds, and straight after a component is installed, as a gateway reads its
workers' catalogs; a removed component leaves it on the next read. A host that
has joined a gateway still answers about itself: its `drained` is `false`
even when the gateway has drained it, because that flag is the gateway's.

The drain, undrain and remove routes answer `501 UNSUPPORTED_IN_WORKER_MODE`
on a single host, with `operation` in the body: there is no gateway there to
take the host out of rotation or forget it.

### Operator routes

Role: `operator` for all six. `GET /v1/leases` also answers an `agent`
token, with only its own leases. `GET /v1/lease-requests` and `GET /v1/tokens`
answer it `403 FORBIDDEN`.

`DELETE /v1/leases/{id}` with an `operator` token already releases any single
lease, on a gateway as anywhere else. The fleet-wide form of that — the CLI's
`simlock release --all` — releases **only gateway-issued leases**, on every
connected worker, and never a worker's own local leases: the gateway did not
issue those, does not know who is holding them, and taking a local
developer's device away from an endpoint they have never heard of is not an
operator action anyone asked for. A worker it cannot reach is reported as
`WORKER_UNREACHABLE` naming that worker, and the leases on the workers it
could reach are still released — a partial result, said plainly, rather than
an all-or-nothing that leaves the operator guessing.

- `GET /v1/leases` — every active lease (`simlock list --leases`).
- `GET /v1/lease-requests` — every request waiting for a device
  (`simlock list --requests`); see below.
- `GET /v1/devices` — every managed device, with state,
  `transitionAgeMs` and `stalled` as [`GET /v1/status`](#get-v1status)
  describes them (`simlock list --devices`).
- `GET /v1/events?since=<duration>` — replay business events newer than
  `since` (`simlock events --since`). They come from the daemon's event file,
  so they include events from before a daemon restart and beyond the 1000
  held in memory, back to the oldest event the file still holds
  (`eventLog.retention` and `eventLog.maxBytes`). `since` takes `ms`, `s`,
  `m`, `h` and `d` units (`?since=2d`). Without `since`, the recent events held in
  memory. Every event carries an `id`, the same one after a daemon restart;
  events written before the upgrade that added it are not returned. Events
  come back by `timestamp`, then in the order the daemon recorded them within
  the same millisecond. On a gateway, a worker's event keeps the `id` and
  `timestamp` it has on the worker and gains `payload.workerId`; its time is
  when it happened on the worker.
- `GET /v1/events/stream` — Server-Sent Events follow of the event bus
  (`simlock events --follow`). Each event carries the same `id` as in
  `GET /v1/events`, and a relayed one the same `timestamp` too. A worker event
  with a `timestamp` beyond 8.64e15 ms either side of the epoch is not relayed.
- `GET /v1/tokens` — every token this daemon knows (`simlock token list`):

  ```json
  { "tokens": [
      { "id": "tok_9f2c", "role": "agent", "label": "ci-runner-3", "createdAt": 1735689600000 }
  ] }
  ```

  A token's `id` is the `requesterId` on the leases it takes over HTTP, so a client can
  show a lease's holder by the token's `label`. The answer never carries a
  secret or a hash. `label` is absent from a token created without one.

On a **gateway** the first five are fleet-wide, which is what makes a single
console possible: `/v1/leases` and `/v1/devices` return every connected
worker's, each record carrying the `workerId` it lives on,
`/v1/lease-requests` returns the gateway's queue and every connected
worker's, and the two event routes carry the workers' republished events
(also `workerId`-tagged) interleaved with the gateway's own `worker.*` and
`request.dispatched` facts. `/v1/tokens` lists the daemon's own tokens: on a
gateway, the gateway's, since tokens never cross machines.

#### `GET /v1/lease-requests`

Every request still waiting for a device, oldest first, whoever sent it. An
`agent` token gets `403 FORBIDDEN`.

```json
{ "requests": [
  { "id": "req_7", "requesterId": "agent-b",
    "spec": { "platform": "ios", "model": "iPhone 16", "osVersion": "18.4", "mode": "slim" },
    "createdAt": 1790864071200, "stage": "queued", "queuePosition": 1 },
  { "id": "req_9", "requesterId": "local-agent",
    "spec": { "platform": "android", "model": "Pixel 8" },
    "createdAt": 1790864075000, "stage": "starting", "workerId": "3f81a2c4" }
] }
```

- `spec` is the device as the request named it: `platform` and `model`, and
  `osVersion`, `mode` and `imageTag` only when the request named them, and
  `physical: true` for a request for an enrolled physical device.
- `createdAt` is when the daemon holding the request received it, in
  milliseconds since the epoch.
- `stage` is `queued` while the request holds a place in the queue, and
  `starting` while the daemon is working on it: placing it as it arrives, or
  finding, creating, booting or downloading a device for it.
- `queuePosition` is set only while `queued`: its place in the request's own
  line, simulator and emulator requests or physical requests, counting from 1,
  the requests ahead of it in that line that are already starting included. It
  is the request's place now, not the one its `queued` progress first reported.
- A request leaves the list as soon as it is granted, fails or is cancelled.
  The request's idempotency key and owner are never listed.

On a **gateway** the list is the gateway's own queue first, without
`workerId`, then the requests waiting in each connected worker's own queue,
from that worker's local agents, each with the **`workerId`** whose queue it
is in. A request the gateway has sent to a worker is listed once, as the
gateway's own. A worker's `createdAt` comes from that worker's clock.

### `/v1/agent-device/*`

A **worker** with `agentDevice.enabled` and `http.enabled` both `true` serves
agent-device's proxy URL here. Point the agent-device CLI at it and give it
your Simlock token:

```bash
export AGENT_DEVICE_DAEMON_AUTH_TOKEN=<simlock token>
agent-device connect proxy --daemon-base-url http://<worker>:<port>/v1/agent-device
agent-device open MyApp --platform ios --device "iPhone 17 Pro"
agent-device snapshot
agent-device close
```

With `agentDevice.enabled` `false` or unset, on a worker or a gateway, every
`/v1/agent-device` URL answers `404`.

Downloads (artifacts) up to 2 GB (2147483648 bytes) are carried. A download
whose `content-length` is over that is answered `413` with
`{"ok": false, "code": "INVALID_ARGS", "error": "..."}` before any byte is
read. A download with no usable `content-length` that passes 2 GB is cut with
a failed response, never one that ends as if it were whole.

A **gateway** with `agentDevice.enabled` serves the same URL, and the CLI is
pointed at the gateway the same way. `open` lands only on a worker whose
agent-device is available, and the commands, heartbeats and `close` of that
lease go to the same worker. An agent on a gateway never shares an
agent-device session with an agent on a worker's own tokens. Through a gateway:

- `GET /health` answers the proxy's health from a worker whose agent-device is
  available. With no such worker it answers `agent-device is not available on
  this simlock: no worker connected to this gateway can serve agent-device`
  with status 200.
- A worker that is draining takes no new `open`, and keeps serving the leases
  it holds.
- Uploads, artifact downloads and diagnostics name their lease in the
  `x-agent-device-lease-id: <lease id>` header, which agent-device sends once
  it holds a lease. The request goes to the worker holding that lease. An
  upload ticket works through the gateway: it carries your own `authorization`
  and `x-agent-device-token`, so the `PUT` that follows reaches the gateway
  with them, and the worker never sees your token. A header that is not 32
  lower-case hex characters is refused with `refused: the
  x-agent-device-lease-id header is not a lease id` (status 400). `/health`
  does not read the header.
- A request that names no lease, or sends the header empty, other than
  `/health`, is refused with
  `refused: this agent-device is too old to use through a gateway; update it`.
  That includes an upload, an artifact download or a diagnostics request with
  no header, and the artifact list.
- `devices` lists your devices across every worker that holds one of your
  leases, and answers an empty list when you hold none.
- A request that names a lease the token does not hold, or the gateway does not
  know, is refused with `refused: lease <id> is not one of yours on this
  gateway` (status 403). A lease `simlock release --all` ended stays known for
  one `lease.maxTtlMs` afterwards, so its next heartbeat answers `lease ended
  by simlock; run disconnect, then open`.

- **Every route needs the Simlock token.** No token is `401`, a worker join
  token is `403`, and so is an `operator` token, with
  `refused: agent-device through simlock needs an agent token`.
- **Each agent needs its own Simlock token.** Simlock tells agents apart by
  token: two agents sharing one token share one agent-device session.
- **`open` leases a device from Simlock.** The device is picked by Simlock,
  and waits in Simlock's queue, up to 330 seconds, when every match is taken.
  The lease is an ordinary Simlock lease: `simlock list` shows it, owned by the
  token's principal, and the lease ID is the 32-hex ID the CLI chose. `close`
  ends the agent-device lease and then frees the Simlock lease, so Simlock
  wipes the device for the next agent.
- **`devices` lists only the agent's own devices.** Before `open` it answers
  an empty list; after, the devices Simlock leased to that token.
- **Heartbeats keep the lease.** The CLI sends one before every command except
  `devices`. Once agent-device answers it, Simlock renews the lease to now plus
  its TTL, unless the lease already runs longer (a longer renewal by the agent
  stands). A heartbeat's `ttlMs` changes that TTL, at least 5 seconds and at
  most `agentDevice.leaseTtlCapMs` when that is set. While a command runs, the
  lease is renewed every third of its TTL, and once more when the command ends.
  An agent that stops sending heartbeats loses the device one TTL later.
- **A lease Simlock ended is not replaced quietly.** When the lease is gone
  because Simlock ended it (`simlock release`, `release --all`, expiry, a lost
  device, a restart of the agent-device daemon or of Simlock), the next
  heartbeat answers `lease ended by simlock; run disconnect, then open`, as an
  `UNAUTHORIZED` error with `details.reason` `LEASE_ENDED_BY_HOST`. A lease the
  agent ended through `close` or `disconnect` answers agent-device's own
  `LEASE_NOT_FOUND`, so `close` then `open` works. A heartbeat Simlock cannot
  renew for another reason answers `COMMAND_FAILED` with Simlock's message.
- **An unreachable worker answers "try again".** Through a gateway, when the
  worker holding the agent's device is not connected, or has reconnected and
  the gateway has not read it yet, every request for that device (a command,
  heartbeat, `close`, an upload naming the lease, and `devices`) answers
  `agent-device is not available on this simlock: the worker holding this
  device is not connected to the gateway; try again` with status 503. A
  `/rpc` answer carries `details.reason` `WORKER_UNREACHABLE`. Nothing is sent
  to the worker and the Simlock lease is untouched; once the worker is back and
  read, before the lease ran out, the next request works. A command running
  when the connection drops answers the same. The same answer covers a lease
  the gateway does not know yet in the first 60 seconds after it starts.
- **A gateway restart keeps the agent's device.** Once the worker reconnects,
  the agent's next request of any kind works on the same device, with no
  `open`. A lease the agent did not make through this front (another token's,
  or one made under another requester) is not picked up. On a worker, a
  restart of Simlock still ends the agent-device lease.

What `open` asks Simlock for:

| The agent passes | Simlock is asked for |
| --- | --- |
| `--platform ios` or `android` | that platform, any device Simlock grants |
| `--target mobile`, `tv`, `desktop` | the class `phone`, `tv`, `desktop` |
| `--device "iPhone 17 Pro"` | that model, and no class: the model wins over `--target` |
| `ttlMs` | that TTL, at least 5 seconds and at most `agentDevice.leaseTtlCapMs` when set; none sent means that cap, or `lease.defaultTtlMs` without one |

Messages the route prints. The agent-device CLI reads the message in the body
(a JSON-RPC error on `/rpc`, `{ "ok": false, "error", "code" }` elsewhere), not
the status.

- `agent-device is not available on this simlock: <reason>`: agent-device is
  turned on but missing, too old, starting or crashed (on a gateway: no
  connected worker can serve it, or the worker holding the lease cannot). The rest of Simlock
  works as before. `GET /health` answers it with status 200, because the
  agent-device CLI treats a `/health` status of 500 or more as an unreachable
  daemon and would print only `Remote daemon is unavailable`; the first
  command then prints the reason.
- `timed out waiting for a device; nothing was leased`.
- `refused by simlock: <message>`: Simlock refused the lease request, for
  example a model it does not know, or a `ttlMs` above `lease.maxTtlMs`.
- `refused: only iOS and Android`, `refused: name --platform ios or android`,
  and `refused: <platform> is not available on this simlock` for a platform
  whose driver is off on this worker.
- `refused: simlock picks the device`: a `--udid`, `--serial`, `--device` or
  device key that is not the device Simlock leased to the agent. A
  `--device` naming the leased device's model is sent on as that device's ID.
- `refused: simlock chooses the device set; run disconnect, then connect proxy
  without --ios-simulator-device-set` and `refused: simlock chooses the
  devices; run disconnect, then connect proxy without
  --android-device-allowlist`: on any command.
- `refused: send the app from your machine as an upload`: `install` or
  `reinstall` of a path on the worker.
- `refused: no device leased; run open first`: a sharded `test` with no
  `--device` from an agent holding no matching device. With a device leased,
  Simlock adds the agent's leased devices as `--device`, each by the name
  agent-device gave it (by its ID when it gave none or the name has a comma).
- `refused: name the device with --udid <id>; run devices to see yours`:
  `capabilities` or `doctor` that names no device from an agent not holding
  exactly one.
- `refused: run devices on its own`, `refused: devices does not stream through
  simlock`, `refused: a batch step cannot name another lease`,
  `refused: malformed <field>`, `refused: unknown method <method>`, and
  `refused: unknown route <method> <path>` (answered `404`).
- `could not check your leases; try again`: Simlock could not list the
  agent's leases within 5 seconds.
- `refused: this agent-device is too old for simlock; upgrade it`: the CLI
  sent no lease ID.
- `refused: send lease calls as lease RPCs`: a lease call inside
  `agent_device.command`.
- `refused: ttlMs must be a positive number of milliseconds`: on `open` and on
  a heartbeat.
- `lease ended by simlock; run disconnect, then open`: a heartbeat for a lease
  Simlock ended.
- `refused: simlock leases only plain devices`: a `backend` other than
  `ios-instance` on iOS or `android-instance` on Android (the one
  `connect proxy` sends), `retainOnClose: true`, a `provider*` or `aws*` key, or a `leaseProvider`
  other than `proxy`.
- `refused: agent-device through simlock needs an agent token`.
- `refused: request body over 1 MiB` and `refused: send one JSON-RPC request`
  (a body that is not JSON, a JSON array, or an object with no string
  `method`); both answer with `id: null`.

## Errors

Every failure is the same shape the daemon protocol uses:

```json
{ "error": { "code": "NO_CAPACITY", "message": "..." } }
```

| HTTP | Codes |
|---|---|
| 400 | `BAD_REQUEST` (malformed body, bad query param, validation) |
| 401 | `UNAUTHENTICATED` (missing or unrecognized token) |
| 403 | `FORBIDDEN` (role doesn't permit the route — including a `worker` token on any `/v1` route other than `/v1/uplink`, and an `agent`/`operator` token at `/v1/uplink`; a `/v1/lease-requests/*` route whose request another token sent; or `POST /v1/leases/{id}/renew`/`DELETE /v1/leases/{id}`/`POST /v1/leases/{id}/exec` naming another requester's still-live lease), `DOWNLOADS_DISABLED` (`POST /v1/components/install` under `downloads.policy: "never"`) |
| 404 | `UNKNOWN_WORKER` (`POST`/`DELETE /v1/workers/{id}/drain` naming a worker the gateway does not know), `UNKNOWN_LEASE_REQUEST` (unknown request id), `UNKNOWN_LEASE` (unknown lease id, expired/released, **or `GET /v1/leases/{id}`/`GET /v1/leases/{id}/events` naming another requester's lease** — see [`GET /v1/leases/{id}`](#get-v1leasesid)) , `UNKNOWN_DEVICE` (`DELETE /v1/devices/{id}` naming a device that is not enrolled) |
| 409 | `REQUESTER_ALREADY_LEASED` (body names the existing lease id; fleet-wide on a gateway), `LEASE_ID_TAKEN` (a `leaseId` an active lease or a waiting request holds; body carries `leaseId`; on a gateway, one of the gateway's own leases or requests, or a worker that refused it), `IDEMPOTENCY_CONFLICT` (an `Idempotency-Key` repeated with a different device or `leaseId`), `REQUEST_NOT_CANCELLABLE` (body names the lease id if the request had already been granted), `WORKER_CONNECTED` (`DELETE /v1/workers/{id}` while its uplink is open), `COMPONENT_NOT_OWNED`, `COMPONENT_IN_USE` (body carries `devices` and `foreignDevices`), `COMPONENT_BUSY` (the three refusals of `DELETE /v1/components/{platform}/{version}`), `DEVICE_BUSY` (`POST /v1/devices`, `DELETE /v1/devices/{id}` of a leased, reclaiming or held device; body carries `id` and `reason`) |
| 422 | `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`, `CAPABILITY_MISSING` (a request required capabilities no worker able to serve it has available; body carries `capabilities`), `DEVICE_NOT_ENROLLABLE` (`POST /v1/devices`; body carries `id`, `platform`, `reason`, and `canonicalId` when known), `PASSTHROUGH_REFUSED` (a refused `exec` verb or `devicectl` command, a caller-supplied `--set`/`-P`, a bare `adb shell`), `UNKNOWN_PASSTHROUGH_TOOL` |
| 501 | `UNSUPPORTED_IN_GATEWAY_MODE` (an operation that acts on one machine, asked of a gateway: `POST /v1/components/install`, `GET /v1/components`, `DELETE /v1/components/{platform}/{version}`, `POST /v1/devices`, `DELETE /v1/devices/{id}`), `UNSUPPORTED_IN_WORKER_MODE` (an operation on a gateway's workers, asked of a single host: `POST`/`DELETE /v1/workers/{id}/drain`, `DELETE /v1/workers/{id}`, `POST /v1/components/install` with `workers`) |
| 503 | `NO_CAPACITY` (with `noWait: true`, or, on a gateway, when no worker that takes requests can serve the request; response carries `Retry-After`), `WORKER_UNREACHABLE` (a gateway could not reach the worker holding this lease or request) |
| 504 | `EXEC_TIMEOUT` (a `device.exec` command outlived `exec.timeoutMs`), `DOWNLOAD_TIMEOUT` (a runtime download, waiting for another download included, outlived `downloads.timeoutMs`) |

Four notes on these codes.

`WORKER_UNREACHABLE` sits on `503` with `NO_CAPACITY` rather than on `502`,
because its `kind` is `transport` and every other `transport`-kind code in
the contract's table (`DAEMON_STOPPING`, `DAEMON_STARTUP_FAILED`,
`DAEMON_CONNECTION_LOST`) is already a `503`. "Try again shortly, the thing
behind this is not reachable right now" is the same answer in all four cases,
and a client with one retry rule for `transport` should not need a second one
because the unreachable thing happened to be a worker.

`UNSUPPORTED_IN_GATEWAY_MODE` comes from five routes in this version,
`POST /v1/components/install` without `workers`, `GET /v1/components`,
`DELETE /v1/components/{platform}/{version}`, `POST /v1/devices` and
`DELETE /v1/devices/{id}` asked of a gateway — `nuke`,
`cleanup`, and
`doctor` are absent from the HTTP surface (see
[Not implemented](#not-implemented)), and the status is fixed so adding
`POST /v1/doctor` or `POST /v1/cleanup` later is additive rather than a fresh
decision. `501` is the honest status for it: this is not a temporary
condition to retry past, it is an operation this daemon will never perform,
and `nuke`/`cleanup`/`doctor`/`driver.passthrough` and component listings
and removals stay per-worker permanently rather than pending some later
fan-out. A component install through a gateway is a different request, one
that names its workers.

`UNSUPPORTED_IN_WORKER_MODE` is the same refusal from the other side: the
operation acts on a gateway's workers, and the daemon is a single host. It
is permanent for that daemon, so do not retry it. Both codes carry
`operation` in the body.

`EXEC_TIMEOUT`'s `504` is documented for completeness rather than for the
exec route: `POST /v1/leases/{id}/exec` has already answered `200` and begun
streaming by the time a command can outlive `exec.timeoutMs`, so on that
route it arrives as the stream's terminal `error` event — as does a
`WORKER_UNREACHABLE` that only happens mid-stream. The status is what a
client mapping the code without a route in front of it should use.

`404` also covers `UNKNOWN_WORKER` (body names the `workerId`) on the worker
routes. Where an error carries typed details, they are inlined beside `code`
and `message` — details are contract, message text is not.

## Lifecycle semantics

- **Daemon restart.** Lease requests are stored, so a request id from before
  the restart still answers `GET`. A request that already had its result
  keeps it. A request that was still waiting when the daemon stopped ends as
  `failed`, with a message saying the daemon restarted: no wait survives a
  restart. Repeating it under the same `Idempotency-Key` returns that same
  failure, so send a new key to ask again.
- **Idempotency keys** are stored with their request. A repeat inside
  `lease.requestRetentionMs` of the request finishing gets the stored request
  back, across a restart too. After that window the record is removed and
  the same key starts a new request.
- **Startup.** The HTTP listener now starts the moment the daemon
  claims its socket — the same instant the unix socket itself starts
  accepting connections, before startup convergence (`doctor.reconcile()`,
  running-capacity convergence) has run (**bug fix, 0.3.0**: it
  used to start only once convergence had already finished, so it could not
  observe or need this). A request that arrives before convergence completes
  now waits on the shared dispatcher's readiness gate exactly like a socket
  request, instead of being refused — every route but the routes that don't
  dispatch at all (`GET /v1/healthz`) can block briefly on a cold start.
- **Gateway restart, and a worker that goes away.** A gateway keeps its lease
  requests in memory only, so a gateway restart loses them: their ids answer
  `404 UNKNOWN_LEASE_REQUEST`, and a repeat under the same `Idempotency-Key`
  is treated as a new request. Leases survive it, on their workers, which
  reconnect on their own backoff and let the gateway rebuild every view and
  its lease index. So a client that repeats its request after a gateway
  restart gets a new lease request if `lease.maxPerRequester` leaves room for
  another lease under its agent id, which can leave it holding two leases (`GET`
  the earlier one to recover it); at the limit it gets
  `409 REQUESTER_ALREADY_LEASED` naming a lease it already holds. While a
  worker's uplink is down, anything routed to it is
  `503 WORKER_UNREACHABLE`; the gateway never reports a lease as gone before
  the worker says so, and the lease meanwhile runs out its TTL on the
  worker's own clock.
- **Shutdown.** `simlock daemon stop` closes the HTTP listener (and any open
  connection, in-flight SSE streams included) before tearing down the lease
  engine, so no HTTP request can run against a stopping daemon. Stopping the
  daemon does not release anything: leases persist, and the next daemon
  restores the TTL timer of each lease whose device is still running, from
  its deadline. A lease whose device is not running at that start is ended
  before the daemon serves a request, as `device-lost`; a renew of it answers
  `404 UNKNOWN_LEASE`. A lease whose deadline passed while no daemon was
  running expires as soon as one is.

## Not implemented

- `POST /v1/doctor` and `POST /v1/cleanup` — not part of this version; may
  land as a follow-up.
- `nuke` is absent from the HTTP surface entirely, deliberately: a
  remote fleet-wipe endpoint is a footgun even behind auth. It stays
  SSH/local-only (`simlock nuke`).
- `dataPlane` on the lease object is reserved and always `null` — a
  byte-heavy data plane (live screen streaming, port forwarding, an
  interactive TTY) is tracked separately, not in this version. Running a
  command on the leased device is *not* waiting on it: that is
  [`POST /v1/leases/{id}/exec`](#post-v1leasesidexec), which works over HTTP
  against a lone worker and through a gateway alike.
- **File transfer for `exec`.** A command that names a path resolves it on
  the machine that owns the device; there is no upload route in this version,
  and the seam for a later `device.upload` is left open by design.
- MCP-over-HTTP and in-process TLS are out of scope for this version too.
  Multi-host brokering is no longer on this list: it is designed as gateway and
  worker modes, and its routes (`/v1/uplink`, `/v1/workers*`) are documented
  above.
