# 0012. A worker answers the fleet operations as a fleet of one

- **Status:** Proposed
- **Date:** 2026-10-02
- **Issue:** [#88](https://github.com/callstackincubator/simlock/issues/88)
- **Supersedes:** nothing. Narrows [ADR
  0005](0005-gateway-and-worker-modes.md): requirements 8 and 23 made
  `worker.list|drain|undrain|remove` gateway-only. Narrows [ADR
  0010](0010-components-have-one-owner-in-the-core.md) §7: a worker no
  longer answers `worker.install-component` with `UNKNOWN_REQUEST`.
- **Depends on:** [ADR 0003](0003-one-typed-daemon-contract-behind-every-frontend.md)
  and ADR 0005.

## Context

#88 says a single host looks like a gateway with one worker, so an
operator learns one console, not two. Today a worker does not implement the
five gateway-only operations in `GATEWAY_ONLY_OPERATIONS`. Its dispatcher
leaves them out of its handler table on purpose, so they answer
`UNKNOWN_REQUEST`. Over HTTP the `/v1/workers` routes are not registered on a
worker and answer `404`.

The console could build a one-worker view from `GET /v1/status` itself. It
would then hold a second copy of the rules that turn a worker's reads into a
view, and the two would drift. ADR 0003 puts one contract behind every
frontend, so the answer belongs in the daemon, and the CLI gets it too.

## Decision

### 1. `worker.list` answers on a worker

On a worker, `worker.list` returns exactly one view: the worker itself.

| Field | Source on a worker |
| --- | --- |
| `id` | the worker's instance id, the one it presents to a gateway |
| `label` | `gateway.label` when set; absent otherwise |
| `connection` | `connected` |
| `drained` | `false` |
| `lastSeenAt` | the time of the call |
| `version` | the daemon's own version, the one it sends in `hello` |
| `protocol` | absent |
| `health`, `capacity`, `host`, `installs`, `leases`, `queueDepth` | its own `status.get` |
| `devices` | its own `list.get` for devices, narrowed to the status device shape |
| `catalog` | its own `catalog.get` |
| `downloads`, `lease` | its own config |

A gateway reads the same five things over the uplink. One pure function in
`src/contract` turns the results of those reads into a view's fields. The
gateway's `WorkerLink` and the worker's dispatcher both call it, so the two
views cannot disagree about a field. Each caller adds its own `id`,
`label`, `connection`, `drained` and `lastSeenAt`.

The worker's dispatcher gains its instance id and `gateway.label` as
options. The daemon already reads both at start.

The view describes the host as it sees itself. A worker that has joined a
gateway still answers about itself. Its `drained` is `false` even if the
gateway drained it: that flag is the gateway's, not the worker's.

### 2. The other gateway-only operations refuse with their own code

`GATEWAY_ONLY_OPERATIONS` is removed. The worker's dispatcher implements
every operation.

On a worker, `worker.drain`, `worker.undrain`, `worker.remove` and
`worker.install-component` fail with a new code,
`UNSUPPORTED_IN_WORKER_MODE`. It mirrors `UNSUPPORTED_IN_GATEWAY_MODE`:
HTTP `501`, CLI exit `2`, details `{ operation }`. Their handlers throw it,
as the gateway's do for the operations it refuses.

So `POST /v1/components/install` with `workers` on a worker answers `501`.
Without `workers` it installs on that worker, as today.

### 3. The routes

`GET /v1/workers`, `POST /v1/workers/{id}/drain`,
`DELETE /v1/workers/{id}/drain` and `DELETE /v1/workers/{id}` are
registered in both modes. They still need an operator token.

### 4. The wire

The operations, their inputs and the view's shape do not change. No
protocol version moves. An older client that gets the new code shows it as
`UNKNOWN_DAEMON_ERROR` with the daemon's message, and an older CLI exits `1`
instead of `2`.

## Consequences

- The console reads the same route for workers in both modes.
- `simlock worker list` on a single host prints that host.
- A script that used `UNKNOWN_REQUEST` from `worker list` to tell a worker
  from a gateway breaks. `status`'s daemon `mode` is, and stays, the way to
  tell them apart.
- The task that makes this true updates:
  - `src/contract/errors.ts`: `ErrorDetailsMap`, `ERROR_TABLE` and the
    declared-details table.
  - `HTTP-API.md`: the paragraph that says a worker answers these routes
    with `404`, and the `501` row of the error table.
  - `CLI.md`: the exit-code table and its notes, and every place that says a
    worker command answers `UNKNOWN_REQUEST` on a worker.
  - `CLIENT.md`, where it names `UNSUPPORTED_IN_GATEWAY_MODE`.
  - `docs/internal/ARCHITECTURE.md`, where it describes the gateway-only
    operations.
  - The test in `src/http/app.test.ts` that expects `404` for the worker
    routes on a worker.

## Alternatives considered

- **The console builds the view from `/v1/status`.** Rejected: see Context.
- **Only the HTTP route answers on a worker.** Rejected: it breaks ADR
  0003's one contract, and the CLI would answer differently from HTTP.
- **Keep `UNKNOWN_REQUEST` for the operations a worker cannot do.**
  Rejected: it says the daemon does not know the operation. A refusal with
  its own code says the operation does not apply here, which is the truth.
- **Keep `worker.install-component` at `UNKNOWN_REQUEST`.** Rejected: one
  rule for every gateway-only operation is easier to hold than an exception.
