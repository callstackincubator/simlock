# Contract

Does: the one typed daemon contract — operations, schemas, roles, errors, pushes, protocol range.
Entry: `index.ts` → `OPERATIONS`, `PUSH_SCHEMAS`, `ERROR_TABLE`, `PROTOCOL_VERSION_RANGE`,
OS range helpers and `parseDurationMs`.
Uses: zod only. Never imports: anything outside `src/contract/` (`.dependency-cruiser.mjs`,
rule `contract-imports-nothing`).
Imported by: daemon, gateway, simlock-client, every frontend, core, leasing, history.

## Files

| File               | Role                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.ts`    | Every operation: name, role, effect, input, output, `authorize`; `OPERATIONS`                                                                                                                                                                           |
| `schemas.ts`       | Wire shapes, re-declared by hand from core; `fit*` bounders                                                                                                                                                                                             |
| `roles.ts`         | `Role`, `AuthorizeContext`, `ownsLease`                                                                                                                                                                                                                 |
| `errors.ts`        | `ErrorDetailsMap`, `ERROR_TABLE`, `SimlockError`, `fromWireError`                                                                                                                                                                                       |
| `pushes.ts`        | `PUSH_SCHEMAS`: every push kind                                                                                                                                                                                                                         |
| `protocol.ts`      | `PROTOCOL_VERSION_RANGE`, negotiation, `hello` schemas                                                                                                                                                                                                  |
| `worker-view.ts`   | `workerViewFields`, view refresh interval and events                                                                                                                                                                                                    |
| `inbox.ts`         | The Inbox rules: `inboxItems` (what needs the operator, with each item's group, key and subject), `problemCount`, and the helpers they call (`holderOf`, `workerOfLease`, `isExpiring`, ...); no runtime import, so the console imports it by this path |
| `os-range.ts`      | OS constraint grammar: parse, `satisfies`, `compareVersions`                                                                                                                                                                                            |
| `version-order.ts` | `isNewerVersion(candidate, running)`: the one "newer" rule (semver order) every update surface shares; the console imports it by this path, not the index (the index carries zod)                                                                       |
| `duration.ts`      | `parseDurationMs`, for the CLI and HTTP                                                                                                                                                                                                                 |
| `relay.ts`         | Bounded relay ids, channel ids, headers                                                                                                                                                                                                                 |
| `console-url.ts`   | The console address `status.get` reports                                                                                                                                                                                                                |

## Operations

A call runs in a dispatcher, not here: parse input → role check → `authorize` →
park on readiness (all but `status.get`) → handler → parse output.
`src/daemon/dispatcher.ts` and `src/gateway/dispatcher.ts` each hold a handler for
every operation but `daemon.stop`, which `DaemonServer` answers.

- `agent`: `catalog.get`, `status.get`, `component.list`, `lease.request`, `lease.cancel`,
  `lease.renew`, `lease.release`, `lease.list`, `lease.get`, `driver.passthrough`, `device.exec`,
  `doctor.run` without `fix` or `purgeOrphans`.
- `admin`: every other operation (`list.get`, `config.get`, `inbox.get`, `daemon.stop`, `events.*`,
  `token.*`, `worker.*`, `component.install`, `device.add`, `relay.request`, ...).
- `role` and `effect` may be functions of the validated input: `doctor.run` (role, effect),
  `cleanup.run` (`dryRun` is a `read`).
- `effect` (`read` | `write`) sets the daemon log level only. Never on the wire.

`authorize` hooks (an id nothing knows passes, so the handler's own not-found answers):

- `lease.renew`, `lease.release` — `ownsLease`: admin, or `ownerId` = principal.
- `lease.cancel` — admin, or the pending request's owner = principal.
- `device.exec` — agent: owns the lease and names no `requesterId`. Admin: the lease's
  requester = `requesterId` (default: principal).

Three identities:

- **principal** — fixed at `hello` for the connection. HTTP: the token's id.
- **requester** — per request (`requesterId`, default the principal). The
  one-lease-per-requester key.
- **owner** — `ownerId` on the lease, set from the principal at grant.

## Protocol version

- `PROTOCOL_VERSION_RANGE` in `protocol.ts` holds it, now `{ min: 64, max: 64 }`. `DAEMON_PROTOCOL_VERSION` (`src/daemon-protocol/`) is its `max`.
- Every change to a contract shape bumps it by one in the same PR. Move `min` too, unless
  a compatibility path stays side by side. `.agents/scripts/protocol-bump-check.mjs` checks
  it on push and in CI; it counts every file here as a shape but tests, `index.ts` and the
  helpers its `NOT_SHAPES` lists. A new helper that carries no wire shape goes in that list.
- `hello` picks the highest overlap. None → `PROTOCOL_VERSION_UNSUPPORTED` with both ranges.
  A protocol-2 daemon is mapped by `mapLegacyProtocolMismatch`.
- `daemon.stop` and `daemon.update` are accepted at any version (`DaemonServer` skips the version gate for them; the role check still runs, and readiness too except for `daemon.update {query}`), so the upgrade path exists. Their input and answer never change shape; `operations.test.ts` pins `daemon.update`'s JSON schemas.

## Errors

- `SimlockErrorCode` is a closed union (`ErrorDetailsMap`). `ERROR_TABLE` gives each code
  `kind` (`transport` | `protocol` | `domain`), `cliExitCode` and `httpStatus`.
- `HISTORY_NOT_KEPT` (exit 12, 422, `details.oldestTs`) and `HISTORY_UNAVAILABLE` (exit 1, 503) are `usage.get`'s and `events.replay`'s with `beforeId`; `includeLedger` adds `requests[]` (at most 100,000, newest; `ledgerTruncated` when cut); the window it takes is bounded by `usageWindowSchema` (integers to 8.64e15, `from < to`, 90 days at most) and `usageWindow` (`usage-window.ts`) parses the CLI's flags once for every surface. `events.replay` takes `beforeId` and `limit` (1 to 500), refused with `sinceTs`, and `workerId` (1 to 128 characters) with any of them; `eventsPageQuery` (`events-page.ts`) parses the HTTP query once, with the bounds.
- `fromWireError` wraps an unknown code as `UNKNOWN_DAEMON_ERROR`. That code and `CANCELLED`
  are built client side only.
- `CODES_WITH_DECLARED_DETAILS`: codes whose `details` are contract. The compiler keeps it
  in step with `ErrorDetailsMap`. `NO_CAPACITY` declares `capacityReason` (one of the four
  capacity refusals), set by the worker dispatcher only when a capacity check refused.
- `waitingRequestSchema.reason` is allowed on a `queued` entry only. `workers` (a gateway's
  `queued` entries: one reason per worker) refuses a `capacityReason` with any reason but `full`
  and a `workerId` twice.

## Pushes

- Request-scoped, by frame id: `progress`, `started`, `output`, `component-progress`, `relay-head`.
- Lease-scoped, to every connection whose principal owns the lease: `lease-lost`,
  `device-unhealthy`, `device-recovered`.
- Connection-scoped, by subscription id: `event`.

## Worker view

- `workerViewSchema` (`schemas.ts`): one worker in `worker.list` and `status.get` `workers`.
- `workerViewFields` builds it from `status.get`, `list.get`, `catalog.get` and `config.get`
  answers. A gateway's `WorkerLink` and a worker answering about itself both call it; the
  caller adds `id`, `label`, `connection`, `drained`, `lastSeenAt`, `version`.
- `update`, `lastUpdateFailure` and `latestVersion` come from `status.get`'s `daemon` block; `null` when there
  is nothing to show, and absent until the first status read. A status without an update clears `update`.
- A `starting` worker's view is `health`, `host` and `load` only. Absent, never empty.
- Full re-read every `WORKER_VIEW_REFRESH_INTERVAL_MS` (30 s); catalog at once on
  `WORKER_VIEW_CATALOG_EVENTS` (`component.installed`); status at once on
  `WORKER_VIEW_UPDATE_EVENTS` (`daemon.update-started`, `daemon.update-failed`).

## OS ranges and durations

- OS constraint: a bare version is exact (string equality). A range is one or more of
  `>=`, `>`, `<=`, `<` + a dotted version, joined by single spaces, or `A - B`.
  `^`, `~`, `*`, `||` and `x` read as a range and are refused.
- `lease.request` holds an exact `osVersion` to `componentVersionSchema`'s bound (1 to 64
  characters, no whitespace, control character or `;`, no leading `-`): a downloadable missing
  runtime installs it as a component.
- A partial version covers its prefix: `<=26` takes every 26.x, `>26` excludes it. A version that
  is not dotted integers (`Baklava`) matches only exactly.
- Duration: `500` (ms), `2s`, `3m`, `1h`, `7d`. `undefined` when not one or not a safe integer.

## Rules

- Public types are `z.infer`red from these schemas, never written a second time.
- The daemon parses every handler result through the output schema; a core field the
  schema does not declare is stripped, never sent.
- Wire input is a claim: every field a gateway parses from a worker is bounded here
  (`fit*`, `CONSOLE_URL_MAX_LENGTH`, `relay.ts`).
- One OS grammar (`os-range.ts`), one duration parser (`duration.ts`). Nobody else parses.
- `operations.test.ts` holds the role and effect matrices; an operation missing from
  either fails.

## Adding an operation

1. `operations.ts`: `defineOperation` with name, role, effect, input, output, and
   `authorize` when it acts on one lease. Add it to `OPERATIONS`.
2. `operations.test.ts`: a row in the role matrix and the effect matrix.
3. `protocol.ts`: `PROTOCOL_VERSION_RANGE` + 1.
4. Handlers in `src/daemon/dispatcher.ts` and `src/gateway/dispatcher.ts`. A gateway-only
   operation answers `UNSUPPORTED_IN_WORKER_MODE` on a worker; the reverse,
   `UNSUPPORTED_IN_GATEWAY_MODE`.
5. Client: a method on `SimlockClient` or `SimlockAdminClient` (`src/simlock-client/client.ts`),
   types in `src/simlock-client/types.ts`, re-exported from `src/client/index.ts` or
   `src/admin/index.ts`.
6. Frontends as needed: CLI (`src/cli/commands/`), HTTP (`src/http/app.ts`), MCP only for an
   agent session's need.
7. A new error code: `ErrorDetailsMap` and `ERROR_TABLE` (`errors.ts`).
8. Docs: the website pages that describe it, at least
   [errors.mdx](../../website/src/content/docs/docs/reference/errors.mdx) (documentation rule 9).
