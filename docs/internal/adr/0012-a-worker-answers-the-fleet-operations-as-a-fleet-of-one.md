# 0012. A worker answers the fleet operations as a fleet of one

- **Status:** Proposed
- **Date:** 2026-10-02
- **Issue:** [#88](https://github.com/callstackincubator/simlock/issues/88)
- **Supersedes:** nothing. Narrows [ADR
  0005](0005-gateway-and-worker-modes.md): requirements 8 and 23 made
  `worker.list|drain|undrain|remove` gateway-only. `worker.list` now
  answers on a worker too, and the other three refuse there with their own
  code.
- **Depends on:** ADR 0005.

## Context

#88 says a single host looks like a gateway with one worker, so an
operator learns one console, not two. Today a worker does not implement the
`worker.*` operations. Over HTTP the routes are not registered and answer
`404`. On the CLI, `simlock worker list` fails with `UNKNOWN_REQUEST`.

The console could build a one-worker view from `GET /v1/status` itself. It
would then hold a second copy of the rules that turn a worker's status into
a view, and the two would drift. ADR 0003 puts one contract behind every
frontend, so the answer belongs in the daemon, and the CLI gets it too.

## Decision

### 1. `worker.list` answers on a worker

On a worker, `worker.list` returns exactly one view: the worker itself.

| Field | Value |
| --- | --- |
| `id` | the worker's instance id, the one it presents to a gateway |
| `label` | `gateway.label` when set; absent otherwise |
| `connection` | `connected` |
| `drained` | `false` |
| `lastSeenAt` | the time of the call |
| `protocol` | absent |
| every other field | from the worker's own `status.get` and config, the same sources a gateway reads over the uplink |

One function builds a view from a status and config read. The gateway and
the worker both call it, so the two views cannot disagree about a field.

A worker that has joined a gateway still answers about itself. Its
`drained` is `false` even if the gateway drained it: that flag is the
gateway's, not the worker's.

### 2. The other three refuse with their own code

On a worker, `worker.drain`, `worker.undrain` and `worker.remove` fail with
a new code, `UNSUPPORTED_IN_WORKER_MODE`. It mirrors
`UNSUPPORTED_IN_GATEWAY_MODE`: HTTP `501`, CLI exit `2`, details
`{ operation }`.

`worker.install-component` stays gateway-only. A worker answers it with
`UNKNOWN_REQUEST`, as today. A worker installs with `component.install`.

### 3. The routes

`GET /v1/workers`, `POST /v1/workers/{id}/drain`,
`DELETE /v1/workers/{id}/drain` and `DELETE /v1/workers/{id}` are
registered in both modes. They still need an operator token.

### 4. The wire

The operations, their inputs and the view's shape do not change. No
protocol version moves. An older client that gets the new code shows it as
`UNKNOWN_DAEMON_ERROR` with the daemon's message.

## Consequences

- The console has one code path for both modes.
- `simlock worker list` on a single host prints that host.
- `HTTP-API.md` loses the sentence that says a worker answers these routes
  with `404`, and `CLI.md` loses `worker list` from the `UNKNOWN_REQUEST`
  examples.
- A script that used `UNKNOWN_REQUEST` from `worker list` to tell a worker
  from a gateway breaks. `status`'s daemon `mode` is, and stays, the way to
  tell them apart.

## Alternatives considered

- **The console builds the view from `/v1/status`.** Rejected: see Context.
- **Only the HTTP route answers on a worker.** Rejected: it breaks ADR
  0003's one contract, and the CLI would answer differently from HTTP.
- **Keep `404` for the three mutations.** Rejected: a `404` says the route
  does not exist. A refusal with a code says the operation does not apply
  here, which is the truth.
