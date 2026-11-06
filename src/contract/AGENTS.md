# Contract

Does: the one typed daemon contract — operations, schemas, roles, errors, pushes, protocol range.

## Rules

Shapes:

- Public types are `z.infer`red from these schemas, never written a second time.
- The daemon parses every handler result through the output schema; a core field the schema does not declare is stripped, never sent.
- `config.get` carries a driver's own keys under `ios` and `android`, and a module's under `capabilities`, as sent: a new one is no shape change.
- `lease.request` holds `except` (a slim iOS simulator lease keeping slim categories running, ADR 0066) to one object-level refinement with no path (`exceptRefusal`, `operations.ts`), so every transport answers `BAD_REQUEST` with the message as written: 1 to 16 names matching `EXCEPT_NAME_PATTERN`, none twice, never with `physical`, a platform but iOS or `mode: full`. The worker's default mode and a baseline's mode are checked in leasing.
- Wire input is a claim: every field a gateway parses from a worker is bounded here (`fit*`, `CONSOLE_URL_MAX_LENGTH`, `relay.ts`).
- One OS grammar (`os-range.ts`), one duration parser (`duration.ts`), one usage window (`usageWindow`, `usage-window.ts`), one events page query (`eventsPageQuery`, `events-page.ts`). Nobody else parses.
- `inbox.ts` and `version-order.ts` import nothing at run time: the console imports each by its own path, not the index (the index carries zod).

Operations:

- A call runs in a dispatcher, not here: parse input → role check → `authorize` → park on readiness → handler → parse output.
- An `authorize` hook lets an id nothing knows pass, so the handler's own not-found answers.
- `effect` (`read` | `write`) sets the daemon log level only. Never on the wire.
- `operations.test.ts` holds the role and effect matrices; an operation missing from either fails.

Three identities:

- **principal** — fixed at `hello` for the connection. HTTP: the signed-in identity's.
- **requester** — per request (`requesterId`, default the principal). The one-lease-per-requester key.
- **owner** — `ownerId` on the lease, set from the principal at grant.

Protocol version:

- `PROTOCOL_VERSION_RANGE` in `protocol.ts` holds it, and nothing else writes the number. `DAEMON_PROTOCOL_VERSION` (`src/daemon-protocol/`) is its `max`.
- Every change to a contract shape bumps it by one in the same PR. Move `min` too, unless a compatibility path stays side by side.
- `.agents/scripts/protocol-bump-check.mjs` checks it on push and in CI; it counts every file here as a shape but tests, `index.ts` and the helpers its `NOT_SHAPES` lists. A new helper that carries no wire shape goes in that list.
- `daemon.stop` and `daemon.update` are accepted at any version, so the upgrade path exists. Their input and answer never change shape; `operations.test.ts` pins `daemon.update`'s JSON schemas.

Errors and views:

- `UNKNOWN_DAEMON_ERROR` and `CANCELLED` are built client side only.
- `workerViewFields` is the one builder of a worker view: a gateway's `WorkerLink` and a worker answering about itself both call it.
- In a worker view, `update`, `lastUpdateFailure` and `latestVersion` are `null` when there is nothing to show, and absent until the first status read. A status without an update clears `update`.

## Adding an operation

1. `operations.ts`: `defineOperation`, with `authorize` when it acts on one lease. Add it to `OPERATIONS`.
2. `operations.test.ts`: a row in the role matrix and the effect matrix.
3. `protocol.ts`: `PROTOCOL_VERSION_RANGE` + 1.
4. Handlers in `src/daemon/dispatcher.ts` and `src/gateway/dispatcher.ts`. A gateway-only operation answers `UNSUPPORTED_IN_WORKER_MODE` on a worker; the reverse, `UNSUPPORTED_IN_GATEWAY_MODE`.
5. Client: a method on `SimlockClient` or `SimlockAdminClient` (`src/simlock-client/client.ts`), types in `src/simlock-client/types.ts`, re-exported from `src/client/index.ts` or `src/admin/index.ts`.
6. Frontends as needed: CLI, HTTP, MCP only for an agent session's need.
7. A new error code: `ErrorDetailsMap` and `ERROR_TABLE` (`errors.ts`).
8. Docs: the website pages that describe it, at least [errors.mdx](../../website/src/content/docs/docs/reference/errors.mdx) (documentation rule 9).
