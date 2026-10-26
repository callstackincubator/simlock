# Input

Does: lets a lease's holder (or an operator) send taps, keys and buttons to its device over `WS /v1/leases/{id}/input`, on a worker and through a gateway, in expo serve-sim's messages.
Entry: `index.ts` → `inputModule`, an optional module (ADR 0030, ADR 0049): `worker.ts` `createWorker`,
`gateway.ts` `createGateway`, loaded by the module host only when turned on.
Uses: core (`DeviceInput`, the message types), modules (the context, socket and relay types), ports (`LeaseSocket`).
Never imports: http, gateway, drivers, daemon, leasing, `fs`, `child_process`. Imported by: `module-registry` only.
Off unless `capabilities.input.enabled` (false). Off: nothing loaded, and the `input` capability reads `off`.

## Files

| File              | Role                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `definition.ts`   | `inputModule`: name `input`, empty config section, `http` route data, the two loaders          |
| `worker.ts`       | The worker side from the host's context: capability, hooks, lease route, socket, relay         |
| `gateway.ts`      | The gateway side: lease route, socket, `beforeDrain`                                           |
| `create.ts`       | The two factories; the 426 lease route                                                         |
| `worker-link.ts`  | Worker: finds the lease in the registry; the socket door and the relay door, both to a session |
| `sessions.ts`     | Worker: one device input per lease, its sockets, config, failure, lease end, drain             |
| `channel.ts`      | Worker: a relay channel as a `LeaseSocket`; heartbeat, `0xF1` close                            |
| `gateway-link.ts` | Gateway: the relay open, refusals, one bridge per socket, lease-gone wait, drain               |
| `framing.ts`      | `[len u32][tag u8][payload]` frames, `readFrames`, the `0xF0` and `0xF1` tags                  |
| `refusal.ts`      | The 404, 426 and 503 bodies                                                                    |

## How it works

Two doors reach one session. A standalone worker: the HTTP layer resolves the lease for the caller, then
`socket.open` answers an accept and the upgrade router hands it the upgraded socket. Through a gateway the
same `open` on the gateway calls `relayTwoWay` (`input` target) with `/input/leases/<id>` and the worker's
lease id; the worker's `relayTwoWay` finds the lease and attaches a `channelSocket` to the same session. The
gateway's accept carries `abandon` (`gateway-link.ts`), which the router calls when the handshake is refused after the relay opened.

1. Worker session (`sessions.ts` `attach`): a lease gone from the registry → close 4001 `lease ended`; a failed
   open within 10 s → close 1013; 8 sockets already → close 1013. Else it opens the lease's one device input
   (`ctx.inputs.openInput`, shared by every socket) and, once open, sends `0x83` then `0x82`.
2. `0x82` is the device input's `onConfig` (called at once, then on each change) and goes to every admitted socket.
   An unavailable device input sends `{"width":1,"height":1,"orientation":"portrait","inputUnavailable":true}` and drops messages.
3. Client messages go through `parseClientMessage` (core): bad JSON, an unknown tag, a position outside 0..1,
   `0x07` and anything over 64 KiB are dropped, the socket stays. `0x10` is answered `0x90 {ok:false}`.
4. Ends: the last socket leaves → the device input closes once; `onFailed` → every socket 1013; the
   `beforeDeviceReclaim` hook → every socket 4001 with the lease-end reason; `beforeDrain` → every socket 1001.
5. Gateway bridge (`gateway-link.ts`): client frames (≤ 64 KiB) → channel; channel → client except `0xF0`.
   `0xF1 {code, reason}` closes the client (1001 from a stopping worker is reported as 1011). A channel that
   ends or breaks → 1011 `Worker <id> stopped answering`. `leases.onRemoved` → wait 2 s for that socket's
   `0xF1`, then 4001 `lease ended`. `beforeDrain` → 1001 `Simlock is stopping`.
6. Refusals before the upgrade (gateway): `RELAY_TARGET_MISSING` → 503 `INPUT_UNAVAILABLE`; no head in 10 s →
   503 `WORKER_UNREACHABLE`; another coded relay error → 503 with its code; a worker's own refusal is forwarded.
   A plain GET to the path is the module's lease route: 426.

## State and timers

Memory only: a device input per lease, its sockets, its config, the failed-open memory.

| What                         | Default | Key                              |
| ---------------------------- | ------- | -------------------------------- |
| Sockets per lease            | 8       | fixed, `sessions.ts`             |
| Failed-open memory           | 10 s    | fixed, `sessions.ts`             |
| Gateway relay open           | 10 s    | fixed, `gateway-link.ts`         |
| Worker heartbeat (`0xF0`)    | 5 s     | fixed, `channel.ts`              |
| Wait for the worker's `0xF1` | 2 s     | fixed, `gateway-link.ts`         |
| Client ping (ports router)   | 15 s    | fixed, `ports/upgrade-router.ts` |

## Rules

- No module here imports `ws`: a socket is a `LeaseSocket`. Lease ownership is checked by the HTTP layer only.
- A close reason is cut to 123 bytes (`closeReason`, core).
- Each Tests line has one test: `daemon/input-lease.e2e.test.ts` (wiring), `worker.test.ts`, `gateway.test.ts`.
