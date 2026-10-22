# Worker update

Modules: [gateway](../../../src/gateway/AGENTS.md).

`worker.update` sends `daemon.update` over that worker's uplink, bounded at 90 s
(`UPDATE_UPLINK_BOUND_MS`, `src/gateway/dispatcher.ts`; `WORKER_NOT_CONNECTED` at the limit), then
refreshes the view. An unknown id → `UNKNOWN_WORKER`; a disconnected one →
`WORKER_NOT_CONNECTED`. An `incompatible` worker gets the same frozen call.

- A view with `update` set is skipped by routing (`updating`): the request waits, it does
  not end `NO_CAPACITY`.
- The update and the drain set are separate: an update never calls `setDrained`, and
  `update: null` from the next status clears the view.
- `daemon.update` on the gateway itself goes through the `update` option
  (`src/daemon/update-coordinator.ts`): no lease wait, straight to installing.
