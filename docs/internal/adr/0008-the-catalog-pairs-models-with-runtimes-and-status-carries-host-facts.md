# 0008. The catalog pairs models with runtimes, and status carries host facts

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-01
- **Issue:** [#171](https://github.com/callstackincubator/simlock/issues/171)
- **Supersedes:** nothing. Narrows [ADR
  0005](0005-gateway-and-worker-modes.md): requirement 7 (a worker view also
  holds the worker's host facts), requirement 20 (`status.get` gains `host`),
  requirement 21 (what the union of catalogs means for the new fields), and
  requirement 31 (the protocol moves past 5).

## Context

A gateway picks a worker from the worker's catalog: a list of model names and
a list of runtime versions per platform. Four facts are missing from it.

- Which model runs with which runtime. On iOS a worker can have both and be
  unable to pair them.
- Which other names a worker accepts for a model. Android accepts the AVD id.
- Which ABI and tag each Android system image has.
- What machine the worker is: operating system, architecture, tool versions.

The first three describe what can be leased. The fourth describes the host.
#171 adds all four. It must not change which worker the gateway picks; that
is #173.

## Decision

### 1. The catalog stays "what can be leased here", and grows beside its lists

`models` and `runtimes` keep their content and their meaning. The new facts
are added next to them, keyed by the model name as it appears in `models`:

```json
{ "platform": "android",
  "models": ["My Tablet", "Pixel 8"],
  "runtimes": ["34", "35"],
  "defaultRuntime": "35",
  "modelRuntimes": { "My Tablet": ["34", "35"], "Pixel 8": ["34", "35"] },
  "modelAliases": { "Pixel 8": ["pixel_8"] },
  "images": [ { "runtime": "34", "tag": "default", "abi": "x86_64" },
              { "runtime": "35", "tag": "google_apis", "abi": "arm64-v8a" } ] }
```

- `modelRuntimes` is required and has an entry for every model. An empty
  list means no installed runtime pairs with that model.
- `modelAliases` is required and lists only models that have another name.
- `images` is present only for a platform whose driver has images.

The gateway's routing reads `models` and `runtimes` only. Leaving them as they
are is what keeps its decisions unchanged.

### 2. Installed only

The catalog lists what is on the machine. A runtime or image the worker could
download is not listed, whatever the download policy.

### 3. The catalog and `resolveSpec` cannot disagree

In each driver one function decides which runtimes pair with a model, and one
decides which names a model answers to. `listCatalog` and `resolveSpec` both
call them. A test per driver walks every listed pair and name through
`resolveSpec` and checks that an unlisted pair is refused.

On Android every model pairs with every installed API level, because that is
what `resolveSpec` accepts. An image of a foreign ABI is listed and counts.

### 4. The fleet catalog is a union of each worker's own answer

On a gateway, `modelRuntimes` for a model is the union of what each connected
worker lists for that model. It is never the cross product of fleet models
and fleet runtimes. `modelAliases` is the union per model. `images` is the
union by runtime, tag, and ABI. The new fields carry no per-worker
annotation; the worker list shows each worker's own catalog.

### 5. Host facts are a block of their own in status

`status.get` gains a required `host`:

```json
"host": { "os": "macOS", "osVersion": "15.5", "arch": "arm64",
  "tools": [ { "platform": "ios", "name": "xcode", "version": "16.4", "build": "16F6" },
             { "platform": "android", "name": "emulator", "version": "35.4.9" } ] }
```

It sits beside `daemon`, which describes the process. Every string and the
`tools` list have a length limit in the schema.

### 6. Each fact is read by the module that owns it

Operating system, its version, and the architecture come from a host port,
read once in the composition root. Tool versions come from the driver of
their platform through an optional driver method. The core joins them and
knows no tool by name.

### 7. Status never waits for host facts

`status.get` is the gateway's liveness probe and answers while the daemon is
still starting. Host facts are read at startup and served from memory. Tool
versions are read again in the background once they are older than a fixed
age. A failed read keeps the last value, and a tool that cannot be read is
left out. Neither blocks startup or status.

### 8. A worker view holds the worker's host facts

The gateway copies `host` from the worker's `status.get` into the view, and
`worker.list` returns it with the worker's catalog. A gateway's own
`status.get` reports the gateway's host, with no tools, since it runs no
drivers.

The gateway reads each worker's catalog again on its periodic refresh, not
only on connect. The code already does this; requirement 7 reads as if it
did not. A runtime installed on a worker therefore reaches the view without
a restart of either side.

### 9. Everything is derived

No config key adds to, removes from, or overrides the catalog or the host
facts. There is no new operation, command, endpoint, or event.

### 10. The protocol moves once

The first PR raises the protocol version by one. A worker on the older
protocol then shows as `incompatible` through the path ADR 0005 requirement
31 already describes. Later PRs of this feature add to that same version.

## Consequences

- An operator sees in the worker list how workers differ: pairings, images,
  operating system, tool versions.
- A requester sees which model and runtime pairs can be leased.
- Routing is unchanged. A request by AVD id or in another letter case still
  finds no worker through a gateway until #173 reads the new fields.
- The catalog can list a model with no runtime, and a foreign-ABI image the
  host may not boot. It reports facts and does not judge them.
- The iOS driver accepts an exact version when any installed build of that
  version pairs with the model. Today it checks only the first build.
- An Android profile from `devices.xml` whose name an earlier profile
  already answers to stays in `models`, as today, and still resolves to the
  earlier profile. Cleaning that up would change `models`, so it is left to
  #173.
- Every consumer that parses the catalog strictly must accept the new
  fields; the protocol bump covers that.
- The docs change with the implementation. Each PR updates the docs it makes
  true.

## Alternatives considered

- **Restructure the catalog into one object per model.** Easier to read.
  Rejected for now: routing and every routing test read the flat lists, so
  the change could not leave routing untouched.
- **Put host facts in the catalog.** One document for everything about a
  worker. Rejected: a catalog is a list of leasable devices, and an
  operating system version is not one.
- **A separate manifest operation.** Rejected: the gateway already reads the
  catalog and status from every worker, so a third document would repeat
  them.
- **Let the operator edit or label the catalog.** Rejected for this feature.
  A derived catalog cannot claim what the host cannot do. Labels and
  selectors are a later routing feature.
- **Read tool versions on every status call.** Always fresh. Rejected: it
  would start a process inside the liveness probe.
- **List downloadable runtimes.** Rejected: listing them is slow, needs the
  network, and goes stale. Downloads are a later feature.
