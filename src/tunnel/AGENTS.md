# Tunnel

Does: lets a lease's holder (or an operator) reverse device ports of its Android device to its own machine over `WS /v1/leases/{id}/tunnel`, on a lone worker or through a gateway.
Entry: `index.ts` -> `tunnelModule`, an optional module (ADR 0054): `worker.ts` `createWorker` and `gateway.ts` `createGateway`, loaded by the module host only when turned on.
Uses: contract (`src/contract/tunnel-frames.ts`), core (`DeviceReverse`, `DeviceTcpError`, `closeReason`), modules (the context, socket and relay types), ports (`LeaseSocket`, `Clock`).
Never imports: http, gateway, drivers, daemon, leasing, `fs`, `child_process`. Imported by: `module-registry` only.
Off unless `capabilities.tunnel.enabled` (false). Off: nothing loaded, and the `tunnel` capability reads `off`.

## Files

| File              | Role                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `definition.ts`   | `tunnelModule`: name `tunnel`, empty config section, `http` route data, the two loaders                     |
| `worker.ts`       | The worker side from the host's context: capability, hooks, lease route (426), socket, relay                |
| `gateway.ts`      | The gateway side: lease route (426), socket, `beforeDrain`                                                  |
| `gateway-link.ts` | Gateway: the relay open, refusals, one bridge per socket, lease-gone wait, drain                            |
| `channel.ts`      | Worker: a relay channel as a `LeaseSocket`; heartbeat, `0xF1` close                                         |
| `framing.ts`      | `[len u32][tag u8][payload]` frames (a message up to 65541 bytes), `readFrames`, the `0xF0` and `0xF1` tags |
| `sessions.ts`     | One session per socket: HELLO, rules, connections, window and credit, lease end, drain                      |
| `refusal.ts`      | The 404 `UNKNOWN_LEASE` and 426 bodies                                                                      |

## How it works

The HTTP layer resolves the lease for the caller, then `socket.open` finds the lease and its device in the worker's registry (404 `UNKNOWN_LEASE` when gone) and attaches a session to the upgraded socket.

1. The first frame must be `HELLO`. It is checked whole: bad port, more than 8 tunnels per lease (counted across sockets), `forward` (not available yet), a platform whose driver has no `deviceTcp` (`supports`). A refusal sends `REFUSED {code, message}` and closes 4003.
2. Each reverse tunnel is `ctx.deviceTcp.reverse`. A failure removes the tunnels set before it and refuses with the driver's `DeviceTcpError` code (`TUNNEL_PORT_IN_USE`, `TUNNEL_FAILED`), else `TUNNEL_FAILED`. Then `READY`.
3. A device connection is `OPEN` with the next odd id; its bytes go out as `DATA` only while the caller's window allows, and the worker grants `CREDIT` as it writes to the device. `END` half-closes one direction; a connection ends when both have. A 257th open connection is closed at once.
4. A bad frame is `BAD_REQUEST`, close 4003; a frame for a connection already closed is ignored.
5. The socket closing, the lease ending (`beforeDeviceReclaim`, close 4001 with the reason) and a drain (`beforeDrain`, close 1001) close the session's connections and remove its rules; with an already aborted signal the removal is skipped and reclaim does it.

## Through a gateway

The gateway's `socket.open` calls `relayTwoWay` (`tunnel` target) with the worker's lease id; the worker's `relayTwoWay` finds the lease and device and attaches a `channelSocket` to the same session. The worker sends `0xF0` every 5 s and `0xF1 {code, reason}` when its session closes.

- Holder frames up to 65541 bytes go to the channel; a longer one is refused `BAD_REQUEST` by the gateway, close 4003.
- The channel goes to the holder except `0xF0`. `0xF1` closes the holder with its code and reason (1001 from a stopping worker is reported as 1011). A channel that ends or breaks closes 1011 `Worker <id> stopped answering`.
- `leases.onRemoved` waits 2 s for the worker's `0xF1`, then closes 4001 `lease ended`. `beforeDrain` closes 1001 `Simlock is stopping`.
- Before the upgrade: `RELAY_TARGET_MISSING` is 503 `TUNNEL_UNAVAILABLE`; no head in 10 s is 503 `WORKER_UNREACHABLE`.

## Rules

- The module never checks an owner; the HTTP layer does.
- The module never imports a driver; `ctx.deviceTcp` is the only door to a device.
- A removal that fails is logged at `warn`; the driver keeps the loopback port reserved until reclaim.
